import { createWorker, PSM } from 'tesseract.js'

export type ParsedOcr = { name: string; price: string; unitPrice: string; unitLabel: 'kg' | 'L' | '' }
export type OcrProgress = { status: string; progress: number; photo?: string }
export type PriceTagResult = ParsedOcr & { photo: string; recognizedText: string; confidence: number }

type OcrPass = { parsed: ParsedOcr; text: string; confidence: number }

const PRICE_TOKEN = /(?<![\d.,])(?:\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])/g
const UNIT_CUE = /(?:\/\s?(?:kg|l|lt)\b|\bpor\s?(?:kg|l|lt)\b|\bper\s?(?:kg|l|lt)\b|€\s?\/\s?(?:kg|l|lt)\b|\b(?:kg|l|lt)\s?\/)/i
const WEIGHT_TOKEN = /\b\d+(?:[.,]\d+)?\s?(?:kg|g|mg|ml|cl|dl|l)\b/i

function normalizeAmount(raw: string): string {
  let value = raw.replace(/\s/g, '')
  const comma = value.lastIndexOf(',')
  const dot = value.lastIndexOf('.')

  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot)
    const integer = value.slice(0, decimal).replace(/[.,]/g, '')
    const fraction = value.slice(decimal + 1)
    value = `${integer}.${fraction}`
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.'
    const parts = value.split(separator)
    const decimals = parts.at(-1)?.length ?? 0
    value = decimals === 3 ? parts.join('') : `${parts.slice(0, -1).join('')}.${parts.at(-1)}`
  }

  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 && amount <= 100_000 ? amount.toFixed(2) : ''
}

function amountsIn(line: string): Array<{ value: string; index: number; raw: string }> {
  const amounts: Array<{ value: string; index: number; raw: string }> = []
  for (const match of line.matchAll(PRICE_TOKEN)) {
    const raw = match[0]
    const index = match.index ?? 0
    const before = line.slice(Math.max(0, index - 2), index)
    const after = line.slice(index + raw.length, index + raw.length + 5)
    if (/\d\s*$/.test(before) || /^\s*(?:kg|g|mg|ml|cl|dl|l)\b/i.test(after)) continue
    const value = normalizeAmount(raw)
    if (value) amounts.push({ value, index, raw })
  }
  return amounts
}

function cleanLine(line: string): string {
  return line
    .replace(/[|]/g, ' ')
    .replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3')
    .replace(/[^\p{L}\p{N}€£$.,:/%+'’()\-\s]/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function parseOcr(text: string): ParsedOcr {
  const lines = text.split(/[\r\n]+/).map(cleanLine).filter(Boolean)
  const unitLine = lines.find(line => UNIT_CUE.test(line)) ?? ''
  const unitIndex = lines.indexOf(unitLine)
  const unitAmounts = amountsIn(unitLine)
  if (!unitAmounts.length && unitIndex >= 0) {
    unitAmounts.push(...amountsIn(lines[unitIndex - 1] ?? ''), ...amountsIn(lines[unitIndex + 1] ?? ''))
  }
  const unitPrice = unitAmounts.at(-1)?.value ?? ''
  const unitLabel: ParsedOcr['unitLabel'] = /(?:kg)/i.test(unitLine) ? 'kg' : /(?:\/\s?(?:l|lt)\b|\b(?:l|lt)\s?\/)/i.test(unitLine) ? 'L' : ''

  const priceCandidates = lines.flatMap((line, lineIndex) => {
    if (UNIT_CUE.test(line)) return []
    if (/\b(?:pvpr?|pre[cç]o\s+(?:recomendado|anterior)|recomendado|menos|poupan[cç]a|desconto|promo[cç][aã]o)\b/i.test(line)) return []
    const amounts = amountsIn(line)
    return amounts.map(amount => {
      const hasCurrency = /[€£$]|\beur\b/i.test(line)
      const hasTwoDecimals = /\d+[.,]\d{2}(?!\d)/.test(amount.raw)
      const hasPriceLabel = /\b(?:pvp|pre[cç]o|price|total)\b/i.test(line)
      const score = (hasCurrency ? 4 : 0) + (hasTwoDecimals ? 3 : 0) + (hasPriceLabel ? 2 : 0) - (WEIGHT_TOKEN.test(line) ? 2 : 0)
      return { value: amount.value, score, lineIndex, index: amount.index }
    })
  })

  priceCandidates.sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex || a.index - b.index)
  const price = priceCandidates[0]?.value ?? ''

  const nameLines = lines.map((line, index) => ({ line: line.replace(WEIGHT_TOKEN, '').replace(/\bCONTINENTE(?:\s+BIO)?\b/gi, '').trim(), index })).filter(({ line }) => {
    if ([...line].filter(char => /\p{L}/u.test(char)).length < 3) return false
    if (/[€£$]/.test(line) || UNIT_CUE.test(line)) return false
    if (/\b(?:pvp|pvpr|pre[cç]o(?:\s+por)?|price|total|unidade|quantidade|promo[cç][aã]o|desconto|por\s+(?:kg|l|lt)|menos|recomendado|poupan[cç]a|obrigado|visita)\b/i.test(line)) return false
    if (amountsIn(line).length && !/[a-z]{3}/i.test(line)) return false
    return true
  })

  const firstName = nameLines[0]
  const nextName = nameLines.find(candidate => candidate.index === (firstName?.index ?? -2) + 1)
  const name = [firstName?.line, nextName?.line].filter(Boolean).join(' ')

  return { name, price, unitPrice: unitPrice || (unitLabel && price ? price : ''), unitLabel }
}

function otsuThreshold(histogram: Uint32Array, pixelCount: number): number {
  let total = 0
  for (let i = 0; i < histogram.length; i++) total += i * histogram[i]
  let backgroundWeight = 0
  let backgroundSum = 0
  let bestVariance = -1
  let threshold = 150
  for (let i = 0; i < histogram.length; i++) {
    backgroundWeight += histogram[i]
    if (!backgroundWeight) continue
    const foregroundWeight = pixelCount - backgroundWeight
    if (!foregroundWeight) break
    backgroundSum += i * histogram[i]
    const meansDifference = backgroundSum / backgroundWeight - (total - backgroundSum) / foregroundWeight
    const variance = backgroundWeight * foregroundWeight * meansDifference * meansDifference
    if (variance > bestVariance) {
      bestVariance = variance
      threshold = i
    }
  }
  return Math.max(80, Math.min(205, threshold))
}

function makeOcrVariant(source: HTMLCanvasElement): HTMLCanvasElement {
  const context = source.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D context is unavailable')
  const image = context.getImageData(0, 0, source.width, source.height)
  const histogram = new Uint32Array(256)
  const luminance = new Uint8Array(image.data.length / 4)

  for (let i = 0, pixel = 0; i < image.data.length; i += 4, pixel++) {
    const gray = Math.max(0, Math.min(255, Math.round(0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2])))
    const enhanced = Math.max(0, Math.min(255, Math.round((gray - 128) * 1.45 + 128)))
    luminance[pixel] = enhanced
    histogram[enhanced]++
  }

  const threshold = otsuThreshold(histogram, luminance.length)
  for (let pixel = 0, i = 0; pixel < luminance.length; pixel++, i += 4) {
    const value = luminance[pixel] > threshold ? 255 : 0
    image.data[i] = value
    image.data[i + 1] = value
    image.data[i + 2] = value
    image.data[i + 3] = 255
  }

  const variant = document.createElement('canvas')
  variant.width = source.width
  variant.height = source.height
  const variantContext = variant.getContext('2d')
  if (!variantContext) throw new Error('Canvas 2D context is unavailable')
  variantContext.putImageData(image, 0, 0)
  return variant
}

async function loadImage(file: File): Promise<{ image: CanvasImageSource; width: number; height: number; dispose: () => void }> {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file)
    return { image: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('The selected image could not be decoded'))
      element.src = url
    })
    return { image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => URL.revokeObjectURL(url) }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

async function prepareImage(file: File): Promise<{ photo: string; source: HTMLCanvasElement; enhanced: HTMLCanvasElement }> {
  const decoded = await loadImage(file)
  try {
    const pixels = decoded.width * decoded.height
    const scale = Math.min(1.5, 2400 / Math.max(decoded.width, decoded.height), Math.sqrt(5_000_000 / pixels))
    const source = document.createElement('canvas')
    source.width = Math.max(1, Math.round(decoded.width * scale))
    source.height = Math.max(1, Math.round(decoded.height * scale))
    const context = source.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context is unavailable')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(decoded.image, 0, 0, source.width, source.height)

    const photoCanvas = document.createElement('canvas')
    const previewScale = Math.min(1, 1500 / Math.max(source.width, source.height))
    photoCanvas.width = Math.max(1, Math.round(source.width * previewScale))
    photoCanvas.height = Math.max(1, Math.round(source.height * previewScale))
    const photoContext = photoCanvas.getContext('2d')
    if (!photoContext) throw new Error('Canvas 2D context is unavailable')
    photoContext.drawImage(source, 0, 0, photoCanvas.width, photoCanvas.height)

    return { photo: photoCanvas.toDataURL('image/jpeg', 0.88), source, enhanced: makeOcrVariant(source) }
  } finally {
    decoded.dispose()
  }
}

function makeTagCrops(source: HTMLCanvasElement): HTMLCanvasElement[] {
  const regions = [
    { x: 0.06, y: 0.08, width: 0.88, height: 0.84 },
    { x: 0.02, y: 0.14, width: 0.96, height: 0.70 },
  ]

  return regions.map(region => {
    const crop = document.createElement('canvas')
    const sourceX = Math.round(source.width * region.x)
    const sourceY = Math.round(source.height * region.y)
    const sourceWidth = Math.round(source.width * region.width)
    const sourceHeight = Math.round(source.height * region.height)
    const scale = Math.min(1.7, 2800 / Math.max(sourceWidth, sourceHeight))
    crop.width = Math.max(1, Math.round(sourceWidth * scale))
    crop.height = Math.max(1, Math.round(sourceHeight * scale))
    const context = crop.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context is unavailable')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height)
    return crop
  })
}

function passScore(pass: OcrPass): number {
  const { name, price, unitPrice } = pass.parsed
  return (name ? 10 : 0) + (price ? 10 : 0) + (unitPrice ? 2 : 0) + Math.max(0, pass.confidence) / 100
}

export async function recognizePriceTag(file: File, onProgress: (progress: OcrProgress) => void = () => {}): Promise<PriceTagResult> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um ficheiro de imagem.')
  if (file.size > 20 * 1024 * 1024) throw new Error('A fotografia deve ter menos de 20 MB.')

  const prepared = await prepareImage(file)
  onProgress({ status: 'photo prepared', progress: 0, photo: prepared.photo })
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  try {
    worker = await createWorker(['por', 'eng'], undefined, {
      logger: message => onProgress({ status: message.status, progress: message.progress }),
    })
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1', user_defined_dpi: '300' })

    const passes: OcrPass[] = []
    const run = async (image: HTMLCanvasElement, psm: typeof PSM.SINGLE_BLOCK | typeof PSM.SPARSE_TEXT) => {
      await worker!.setParameters({ tessedit_pageseg_mode: psm })
      const result = await worker!.recognize(image, { rotateAuto: true })
      const text = result.data.text.trim()
      passes.push({ parsed: parseOcr(text), text, confidence: result.data.confidence ?? 0 })
    }

    onProgress({ status: 'recognizing text', progress: 0.05 })
    await run(prepared.source, PSM.SINGLE_BLOCK)
    let best = passes.reduce((current, pass) => passScore(pass) > passScore(current) ? pass : current)

    if ((!best.parsed.name || !best.parsed.price) || best.confidence < 92) {
      const crops = makeTagCrops(prepared.source)
      for (let index = 0; index < crops.length; index++) {
        onProgress({ status: 'cropping label', progress: 0.15 + index * 0.12 })
        await run(crops[index], PSM.SINGLE_BLOCK)
        best = passes.reduce((current, pass) => passScore(pass) > passScore(current) ? pass : current)
        if (best.parsed.name && best.parsed.price && best.confidence >= 68) break
      }
    }

    if ((!best.parsed.name || !best.parsed.price) && best.confidence < 95) {
      onProgress({ status: 'enhancing image', progress: 0.35 })
      await run(prepared.enhanced, PSM.SINGLE_BLOCK)
      best = passes.reduce((current, pass) => passScore(pass) > passScore(current) ? pass : current)
    }

    if ((!best.parsed.name || !best.parsed.price) && best.confidence < 90) {
      onProgress({ status: 'reading sparse label text', progress: 0.65 })
      await run(prepared.source, PSM.SPARSE_TEXT)
      best = passes.reduce((current, pass) => passScore(pass) > passScore(current) ? pass : current)
    }

    const merged: ParsedOcr = {
      name: best.parsed.name || passes.find(pass => pass.parsed.name)?.parsed.name || '',
      price: best.parsed.price || passes.find(pass => pass.parsed.price)?.parsed.price || '',
      unitPrice: best.parsed.unitPrice || passes.find(pass => pass.parsed.unitPrice)?.parsed.unitPrice || '',
      unitLabel: best.parsed.unitLabel || passes.find(pass => pass.parsed.unitLabel)?.parsed.unitLabel || '',
    }
    return { ...merged, photo: prepared.photo, recognizedText: best.text, confidence: best.confidence }
  } finally {
    await worker?.terminate()
  }
}

export function progressMessage(status: string, progress: number): string {
  if (status.includes('language')) return 'A carregar os modelos de português e inglês…'
  if (status.includes('core') || status.includes('worker')) return 'A iniciar o motor de leitura…'
  if (status.includes('cropping')) return 'A focar a etiqueta para ler melhor…'
  if (status.includes('enhancing')) return 'A melhorar a imagem para ler a etiqueta…'
  if (status.includes('sparse')) return 'A procurar texto em diferentes zonas da etiqueta…'
  if (status.includes('recognizing')) return `A analisar a etiqueta… ${Math.round(progress * 100)}%`
  return 'A preparar a leitura da etiqueta…'
}
