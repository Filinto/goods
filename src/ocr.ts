import { createWorker, PSM } from 'tesseract.js'

export type ParsedOcr = { name: string; price: string; unitPrice: string; unitLabel: 'kg' | 'L' | '' }
export type OcrProgress = { status: string; progress: number; photo?: string }
export type PriceTagResult = ParsedOcr & { photo: string; recognizedText: string; confidence: number }

type OcrPass = { parsed: ParsedOcr; text: string; confidence: number; priceHeight: number; nameLength: number }
type OcrLayoutWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
type OcrLayoutLine = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; words?: OcrLayoutWord[] }

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
    .replace(/[^\p{L}\p{N}€£$.,:/%&+'’()\-\s]/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function isNameLine(line: string): boolean {
  if ([...line].filter(char => /\p{L}/u.test(char)).length < 3) return false
  if (/[€£$]/.test(line) || UNIT_CUE.test(line)) return false
  if (/\b(?:oferta|pvp|pvpr|pypr|pre[cç]o(?:\s+por)?|price|total|unidade|quantidade|promo[cç][aã]o|desconto|por\s+(?:kg|l|lt)|menos|recomendado|recome|poupan[cç]a|obrigado|visita|sobre)\b/i.test(line)) return false
  if (amountsIn(line).length && !/[a-z]{3}/i.test(line)) return false
  return true
}

function amountFontHeight(lineIndex: number, value: string, layoutLines: OcrLayoutLine[]): number {
  const layoutLine = layoutLines[lineIndex]
  if (!layoutLine) return 0
  const matchingWords = layoutLine.words?.filter(word => {
    const numericText = word.text.replace(/[^\d.,]/g, '')
    return numericText && normalizeAmount(numericText) === value
  }) ?? []
  if (matchingWords.length) return Math.max(...matchingWords.map(word => word.bbox.y1 - word.bbox.y0))
  return Math.max(0, layoutLine.bbox.y1 - layoutLine.bbox.y0)
}

function amountFromLayoutWords(layoutLines: OcrLayoutLine[]): Array<{ value: string; height: number; line: string }> {
  const candidates: Array<{ value: string; height: number; line: string }> = []

  for (const layoutLine of layoutLines) {
    const line = cleanLine(layoutLine.text)
    if (UNIT_CUE.test(line)) continue
    const words = [...(layoutLine.words ?? [])].sort((a, b) => a.bbox.x0 - b.bbox.x0)
    let group = ''
    let groupHeight = 0
    let groupRight = 0
    let previous: OcrLayoutWord | undefined
    let groupHasSeparator = false
    let groupParts: Array<{ digits: string; height: number }> = []

    const saveGroup = () => {
      const decimalReconstruction = !groupHasSeparator
        && groupParts.length >= 2
        && groupParts[0].digits.length === 1
        && groupParts.slice(1).map(part => part.digits).join('').length === 2
        && groupParts[0].height >= Math.max(...groupParts.slice(1).map(part => part.height)) * 1.4
      if ((groupHasSeparator && /^\d+(?:[.,]\d{1,2})?$/.test(group)) || decimalReconstruction) {
        const nearbyReference = words.some(word =>
          /\b(?:pvpr?|pre[cç]o\s+(?:recomendado|anterior)|recomendado|poupan[cç]a|desconto)\b/i.test(word.text)
          && Math.abs(word.bbox.x0 - groupRight) <= Math.max(80, groupHeight)
          && word.bbox.x0 >= groupRight,
        )
        const reconstructed = decimalReconstruction ? `${groupParts[0].digits}.${groupParts.slice(1).map(part => part.digits).join('')}` : group
        const value = nearbyReference ? '' : normalizeAmount(reconstructed)
        if (value) candidates.push({ value, height: groupHeight, line })
      }
      group = ''
      groupHeight = 0
      groupRight = 0
      previous = undefined
      groupHasSeparator = false
      groupParts = []
    }

    for (const word of words) {
      const fragment = word.text.replace(/[^\d.,]/g, '')
      if (!fragment) continue
      const height = word.bbox.y1 - word.bbox.y0
      const gap = previous ? word.bbox.x0 - previous.bbox.x1 : 0
      const previousHeight = previous ? previous.bbox.y1 - previous.bbox.y0 : height
      const overlapsVertically = !previous || Math.min(word.bbox.y1, previous.bbox.y1) - Math.max(word.bbox.y0, previous.bbox.y0) >= Math.min(height, previousHeight) * 0.25
      const isAdjacent = previous && gap <= Math.max(12, Math.max(height, previousHeight) * 0.45) && overlapsVertically
      if (previous && !isAdjacent) saveGroup()

      if (group.replace(/\D/g, '').length + fragment.replace(/\D/g, '').length > 6) saveGroup()
      group += fragment
      groupHeight = Math.max(groupHeight, height)
      groupRight = word.bbox.x1
      groupHasSeparator ||= /[.,]/.test(fragment)
      groupParts.push({ digits: fragment.replace(/\D/g, ''), height })
      previous = word
    }
    saveGroup()
  }

  return candidates
}

function correctUnitPrice(price: string, unitPrice: string, unitLabel: ParsedOcr['unitLabel'], name: string): string {
  const packageSize = name.match(/\b(\d+(?:[.,]\d+)?)\s?(kg|g|mg|ml|cl|dl|l)\b/i)
  if (!price || !unitPrice || !unitLabel || !packageSize) return unitPrice

  const quantity = Number(packageSize[1].replace(',', '.'))
  const packageUnit = packageSize[2].toLowerCase()
  const matchesUnit = unitLabel === 'kg' ? ['kg', 'g', 'mg'].includes(packageUnit) : ['l', 'dl', 'cl', 'ml'].includes(packageUnit)
  const baseQuantity = packageUnit === 'kg' || packageUnit === 'l' ? quantity
    : packageUnit === 'g' || packageUnit === 'dl' ? quantity / 1000
      : packageUnit === 'cl' ? quantity / 100
        : packageUnit === 'mg' ? quantity / 1_000_000
          : quantity / 1000
  const expected = Number(price) / baseQuantity
  const printedUnitPrice = Number(unitPrice)
  const hundredFold = printedUnitPrice / expected >= 80 && printedUnitPrice / expected <= 120
  return matchesUnit && Number.isFinite(expected) && expected > 0 && hundredFold ? expected.toFixed(2) : unitPrice
}

export function parseOcr(text: string, layoutLines: OcrLayoutLine[] = []): ParsedOcr {
  const lines = text.split(/[\r\n]+/).map(cleanLine).filter(Boolean)
  const unitLine = lines.find(line => UNIT_CUE.test(line)) ?? ''
  const unitIndex = lines.indexOf(unitLine)
  const unitAmounts = amountsIn(unitLine)
  if (!unitAmounts.length && unitIndex >= 0) {
    unitAmounts.push(...amountsIn(lines[unitIndex - 1] ?? ''), ...amountsIn(lines[unitIndex + 1] ?? ''))
  }
  const unitCueIndex = unitLine.match(UNIT_CUE)?.index
  const selectedUnitAmount = unitAmounts.length && unitCueIndex !== undefined
    ? [...unitAmounts].sort((a, b) => Math.abs(a.index - unitCueIndex) - Math.abs(b.index - unitCueIndex))[0]
    : unitAmounts.at(-1)
  const unitPrice = selectedUnitAmount?.value ?? ''
  const unitLabel: ParsedOcr['unitLabel'] = /(?:kg)/i.test(unitLine) ? 'kg' : /(?:\/\s?(?:l|lt)\b|\b(?:l|lt)\s?\/)/i.test(unitLine) ? 'L' : ''

  const priceCandidates = lines.flatMap((line, lineIndex) => {
    if (UNIT_CUE.test(line)) return []
    if (/\b(?:pvpr?|pre[cç]o\s+(?:recomendado|anterior)|recomendado|menos|poupan[cç]a|desconto|promo[cç][aã]o)\b/i.test(line) && !/[€£$]/.test(line)) return []
    const amounts = amountsIn(line)
    return amounts.map(amount => {
      const hasCurrency = /[€£$]|\beur\b/i.test(line)
      const hasTwoDecimals = /\d+[.,]\d{2}(?!\d)/.test(amount.raw)
      const hasPriceLabel = /\b(?:pvp|pre[cç]o|price|total)\b/i.test(line)
      const matchedIndex = layoutLines.findIndex(candidate => cleanLine(candidate.text) === line)
      const layoutHeight = amountFontHeight(matchedIndex >= 0 ? matchedIndex : lineIndex, amount.value, layoutLines)
      const nearbyReferenceCue = /\b(?:pvpr?|recomendado|anterior)\b/i.test(line.slice(Math.max(0, amount.index - 12), amount.index + amount.raw.length + 24))
      const score = layoutHeight * 0.6 + (hasCurrency ? 4 : 0) + (hasTwoDecimals ? 3 : 0) + (hasPriceLabel ? 2 : 0) - (nearbyReferenceCue ? 6 : 0) - (WEIGHT_TOKEN.test(line) ? 2 : 0)
      return { value: amount.value, score, lineIndex, index: amount.index }
    })
  })

  priceCandidates.push(...amountFromLayoutWords(layoutLines).map((candidate, index) => ({
    value: candidate.value,
    score: candidate.height * 0.6 + 8,
    lineIndex: index,
    index: 0,
  })))

  priceCandidates.sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex || a.index - b.index)
  const price = priceCandidates[0]?.value ?? ''

  const nameSource = layoutLines.length
    ? layoutLines.map(layoutLine => {
      const productWords = layoutLine.words?.filter(word => {
        const token = cleanLine(word.text)
        const uppercase = token === token.toLocaleUpperCase()
        return /\p{L}{2}/u.test(token) && (uppercase || WEIGHT_TOKEN.test(token))
      })
      const line = productWords?.length ? cleanLine(productWords.map(word => word.text).join(' ')) : cleanLine(layoutLine.text)
      const wordHeights = productWords?.map(word => word.bbox.y1 - word.bbox.y0) ?? []
      return { line, y: layoutLine.bbox.y0, height: wordHeights.length ? Math.max(...wordHeights) : layoutLine.bbox.y1 - layoutLine.bbox.y0 }
    })
    : lines.map((line, index) => ({ line, y: index, height: 1 }))
  const nameCandidates = nameSource
    .filter(candidate => isNameLine(candidate.line) && !/\bCONTINENTE(?:\s+BIO)?\b/i.test(candidate.line))
    .sort((a, b) => b.height - a.height || a.y - b.y)
  const anchor = nameCandidates[0]
  const selectedNames = anchor
    ? nameCandidates.filter(candidate => candidate.height >= anchor.height * 0.35 && (layoutLines.length === 0 || Math.abs(candidate.y - anchor.y) <= anchor.height * 4))
    : []
  const name = (selectedNames.length ? selectedNames : nameCandidates.slice(0, 2))
    .sort((a, b) => a.y - b.y)
    .slice(0, 3)
    .map(candidate => candidate.line)
    .join(' ')

  const adjustedUnitPrice = correctUnitPrice(price, unitPrice, unitLabel, name)
  return { name, price, unitPrice: adjustedUnitPrice || (unitLabel && price ? price : ''), unitLabel }
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

async function prepareImage(file: File): Promise<{ photo: string; source: HTMLCanvasElement; enhanced: HTMLCanvasElement; priceCrop: HTMLCanvasElement; nameCrop: HTMLCanvasElement }> {
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

    return {
      photo: photoCanvas.toDataURL('image/jpeg', 0.88),
      source,
      enhanced: makeOcrVariant(source),
      priceCrop: makePriceCrop(decoded.image, decoded.width, decoded.height),
      nameCrop: makeNameCrop(decoded.image, decoded.width, decoded.height),
    }
  } finally {
    decoded.dispose()
  }
}

function makeTagCrops(source: HTMLCanvasElement): HTMLCanvasElement[] {
  const regions = [
    { x: 0.10, y: 0.18, width: 0.82, height: 0.68 },
    { x: 0.12, y: 0.22, width: 0.78, height: 0.60 },
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

function makePriceCrop(source: CanvasImageSource, sourceImageWidth: number, sourceImageHeight: number): HTMLCanvasElement {
  const region = { x: 0.195, y: 0.414, width: 0.45, height: 0.256 }
  const sourceX = Math.round(sourceImageWidth * region.x)
  const sourceY = Math.round(sourceImageHeight * region.y)
  const sourceWidth = Math.round(sourceImageWidth * region.width)
  const sourceHeight = Math.round(sourceImageHeight * region.height)
  const scale = Math.min(1.5, 1500 / Math.max(sourceWidth, sourceHeight))
  const crop = document.createElement('canvas')
  crop.width = Math.max(1, Math.round(sourceWidth * scale))
  crop.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = crop.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D context is unavailable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height)
  return crop
}

function makeNameCrop(source: CanvasImageSource, sourceImageWidth: number, sourceImageHeight: number): HTMLCanvasElement {
  const region = { x: 0.20, y: 0.30, width: 0.40, height: 0.16 }
  const sourceX = Math.round(sourceImageWidth * region.x)
  const sourceY = Math.round(sourceImageHeight * region.y)
  const sourceWidth = Math.round(sourceImageWidth * region.width)
  const sourceHeight = Math.round(sourceImageHeight * region.height)
  const scale = Math.min(1.5, 1500 / Math.max(sourceWidth, sourceHeight))
  const crop = document.createElement('canvas')
  crop.width = Math.max(1, Math.round(sourceWidth * scale))
  crop.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = crop.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D context is unavailable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height)
  return crop
}

function passScore(pass: OcrPass): number {
  const { name, price, unitPrice } = pass.parsed
  return (name ? 10 : 0) + (price ? 10 : 0) + (unitPrice ? 2 : 0) + Math.max(0, pass.confidence) / 100 + pass.priceHeight / 1000 + pass.nameLength / 1000
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
      const result = await worker!.recognize(image, { rotateAuto: true }, { blocks: true })
      const text = result.data.text.trim()
      const layoutLines = result.data.blocks?.flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines)) ?? []
      const parsed = parseOcr(text, layoutLines)
      const priceHeight = Math.max(0, ...amountFromLayoutWords(layoutLines).filter(candidate => candidate.value === parsed.price).map(candidate => candidate.height))
      const nameLength = [...parsed.name].filter(character => /\p{L}/u.test(character)).length + (WEIGHT_TOKEN.test(parsed.name) ? 20 : 0)
      passes.push({ parsed, text, confidence: result.data.confidence ?? 0, priceHeight, nameLength })
    }

    onProgress({ status: 'recognizing text', progress: 0.05 })
    await run(prepared.priceCrop, PSM.SINGLE_BLOCK)
    await run(prepared.nameCrop, PSM.SPARSE_TEXT)
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

    const pricePass = [...passes].filter(pass => pass.parsed.price).sort((a, b) => b.priceHeight - a.priceHeight || b.confidence - a.confidence)[0]
    const namePass = [...passes].filter(pass => pass.parsed.name).sort((a, b) => b.nameLength - a.nameLength || b.confidence - a.confidence)[0]
    const unitPass = [...passes].filter(pass => pass.parsed.unitLabel).sort((a, b) => Number(Boolean(b.parsed.unitPrice)) - Number(Boolean(a.parsed.unitPrice)) || b.confidence - a.confidence)[0]
    const merged: ParsedOcr = {
      name: namePass?.parsed.name || best.parsed.name,
      price: pricePass?.parsed.price || best.parsed.price,
      unitPrice: unitPass?.parsed.unitPrice || '',
      unitLabel: unitPass?.parsed.unitLabel || '',
    }
    merged.unitPrice = correctUnitPrice(merged.price, merged.unitPrice, merged.unitLabel, merged.name)
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
