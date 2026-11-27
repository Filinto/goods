import { createWorker, PSM } from 'tesseract.js'

export type ParsedOcr = { name: string; price: string; unitPrice: string; unitLabel: 'kg' | 'L' | '' }
export type OcrProgress = { status: string; progress: number; photo?: string }
export type PriceTagResult = ParsedOcr & { photo: string; recognizedText: string; confidence: number }

type OcrPass = { parsed: ParsedOcr; text: string; confidence: number; priceHeight: number; nameLength: number; packageSize: string; layoutLines: OcrLayoutLine[] }
type OcrLayoutWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence?: number }
type OcrLayoutLine = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; words?: OcrLayoutWord[] }

const MAX_OCR_PASSES = 2
const OCR_PASS_TIMEOUT_MS = 10_000
const OCR_WORKER_TIMEOUT_MS = 18_000
type OcrWorker = Awaited<ReturnType<typeof createWorker>>
let sharedWorkerPromise: Promise<OcrWorker> | undefined
let activeProgress: (progress: { status: string; progress: number }) => void = () => {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer!))
}

async function getOcrWorker(onProgress: (progress: { status: string; progress: number }) => void): Promise<OcrWorker> {
  activeProgress = onProgress
  if (!sharedWorkerPromise) {
    const pending = createWorker(['por'], undefined, { logger: message => activeProgress(message) })
    sharedWorkerPromise = pending
    void pending.catch(() => {
      if (sharedWorkerPromise === pending) sharedWorkerPromise = undefined
    })
  }

  const pending = sharedWorkerPromise
  try {
    return await withTimeout(pending, OCR_WORKER_TIMEOUT_MS, 'O motor de leitura demorou demasiado a iniciar.')
  } catch (error) {
    if (sharedWorkerPromise === pending) sharedWorkerPromise = undefined
    void pending.then(worker => worker.terminate()).catch(() => {})
    throw error
  }
}

const PRICE_TOKEN = /(?<![\d.,])(?:\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])/g
const UNIT_CUE = /(?:\/\s?(?:kg|l|lt)\b|\bpor\s?(?:kg|l|lt)\b|\bper\s?(?:kg|l|lt)\b|€\s?\/\s?(?:kg|l|lt)\b|\b(?:kg|l|lt)\s?\/)/i
const WEIGHT_TOKEN = /\b\d+(?:[.,]\d+)?\s?(?:kg|g|mg|ml|cl|dl|l)\b/i
const NON_PRODUCT_WORD = /^(?:OFERTA|PVP|PVPR|PYPR|PRE[CÇ]O|PRICE|TOTAL|UNIDADE|QUANTIDADE|PROMO[CÇ][AÃ]O|DESCONTO|MENOS|RECOMENDADO|RECOME|POUPAN[CÇ]A|OBRIGADO|VISITA|SOBRE|KG|LT|EUR)$/i

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

function productWordsInLine(line: OcrLayoutLine): OcrLayoutWord[] {
  return (line.words ?? []).filter(word => {
    const token = cleanLine(word.text).replace(/[^\p{L}\p{N}&'’-]/gu, '')
    const letters = [...token].filter(character => /\p{L}/u.test(character)).length
    return (letters >= 3 || (letters >= 2 && (word.confidence ?? 0) >= 85) || WEIGHT_TOKEN.test(token))
      && token === token.toLocaleUpperCase()
      && !NON_PRODUCT_WORD.test(token)
      && (word.confidence === undefined || word.confidence >= 60)
      && (!/^\d/.test(token) || WEIGHT_TOKEN.test(token))
  })
}

function isNameLine(line: string): boolean {
  if ([...line].filter(char => /\p{L}/u.test(char)).length < 3) return false
  if (!line.split(/\s+/).some(token => [...token].filter(char => /\p{L}/u.test(char)).length >= 3)) return false
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
  const numericWords = layoutLines.flatMap(layoutLine => {
    if (UNIT_CUE.test(cleanLine(layoutLine.text))) return []
    return (layoutLine.words ?? []).flatMap(word => {
      const digits = word.text.replace(/\D/g, '')
      return digits ? [{ digits, height: word.bbox.y1 - word.bbox.y0, bbox: word.bbox, line: cleanLine(layoutLine.text) }] : []
    })
  }).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)

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

  for (const leading of numericWords) {
    if (leading.digits.length !== 1) continue
    const followingCandidates = numericWords.filter(word => {
      if (word.digits.length !== 2) return false
      const height = Math.max(leading.height, word.height)
      const gap = word.bbox.x0 - leading.bbox.x1
      const overlap = Math.min(leading.bbox.y1, word.bbox.y1) - Math.max(leading.bbox.y0, word.bbox.y0)
      const overlapRatio = overlap / Math.min(leading.height, word.height)
      const sizeRatio = height / Math.min(leading.height, word.height)
      const horizontalPair = gap >= 0 && gap <= height * 0.55 && overlapRatio >= 0.25
      const verticallyStackedPair = Math.abs(word.bbox.x0 - leading.bbox.x0) <= height * 0.5
        && Math.abs(word.bbox.y0 - leading.bbox.y0) <= height * 0.8
      return (horizontalPair || verticallyStackedPair) && sizeRatio >= 1.35
    }).sort((a, b) => Math.abs(a.bbox.x0 - leading.bbox.x0) + Math.abs(a.bbox.y0 - leading.bbox.y0)
      - Math.abs(b.bbox.x0 - leading.bbox.x0) - Math.abs(b.bbox.y0 - leading.bbox.y0))
    const following = followingCandidates[0]
    if (following) {
      const height = Math.max(leading.height, following.height)
      const value = normalizeAmount(`${leading.digits}.${following.digits}`)
      if (value) candidates.push({ value, height, line: `${leading.line} ${following.line}`.trim() })
    }
  }

  return candidates
}

function correctUnitPrice(price: string, unitPrice: string, unitLabel: ParsedOcr['unitLabel'], name: string, layoutLines: OcrLayoutLine[] = [], fallbackText = ''): string {
  const packageSize = packageSizeFrom(name, layoutLines) ?? fallbackText.match(/\b(\d+(?:[.,]\d+)?)\s?(kg|g|mg|ml|cl|dl|l)\b/i)
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

function packageSizeFrom(name: string, layoutLines: OcrLayoutLine[] = []): RegExpMatchArray | null {
  const expression = /\b(\d+(?:[.,]\d+)?)\s?(kg|g|mg|ml|cl|dl|l)\b/i
  const fromName = name.match(expression)
  if (fromName) return fromName
  return layoutLines.flatMap(line => line.words ?? [])
    .filter(word => (word.confidence ?? 0) >= 60)
    .map(word => word.text.match(expression))
    .find((match): match is RegExpMatchArray => Boolean(match)) ?? null
}

function shelfPriceFromUnit(unitPrice: string, unitLabel: ParsedOcr['unitLabel'], name: string, layoutLines: OcrLayoutLine[] = [], fallbackText = ''): string {
  const packageSize = packageSizeFrom(name, layoutLines) ?? fallbackText.match(/\b(\d+(?:[.,]\d+)?)\s?(kg|g|mg|ml|cl|dl|l)\b/i)
  if (!unitPrice || !unitLabel || !packageSize) return ''

  const quantity = Number(packageSize[1].replace(',', '.'))
  const packageUnit = packageSize[2].toLowerCase()
  const matchesUnit = unitLabel === 'kg' ? ['kg', 'g', 'mg'].includes(packageUnit) : ['l', 'dl', 'cl', 'ml'].includes(packageUnit)
  const baseQuantity = packageUnit === 'kg' || packageUnit === 'l' ? quantity
    : packageUnit === 'g' || packageUnit === 'dl' ? quantity / 1000
      : packageUnit === 'cl' ? quantity / 100
        : packageUnit === 'mg' ? quantity / 1_000_000
          : quantity / 1000
  const amount = Number(unitPrice) * baseQuantity
  if (!matchesUnit || !Number.isFinite(amount) || amount <= 0 || amount > 100_000) return ''
  return (Math.round(amount * 100) / 100).toFixed(2)
}

export function parseOcr(text: string, layoutLines: OcrLayoutLine[] = []): ParsedOcr {
  const lines = text.split(/[\r\n]+/).map(cleanLine).filter(Boolean)
  const unitLine = lines.find(line => UNIT_CUE.test(line) || /^\s*(?:€\s*)?\/?\s*(?:kg|l|lt)\s*$/i.test(line)) ?? ''
  const unitIndex = lines.indexOf(unitLine)
  const unitAmounts = amountsIn(unitLine)
  if (!unitAmounts.length && unitIndex >= 0) {
    const adjacentLines = [lines[unitIndex - 1] ?? '', lines[unitIndex + 1] ?? '']
      .filter(line => !/[€£$]/.test(line) && !UNIT_CUE.test(line) && /\d+[.,]\d{1,2}/.test(line))
    unitAmounts.push(...adjacentLines.flatMap(amountsIn))
  }
  const unitCueIndex = unitLine.match(UNIT_CUE)?.index
  const selectedUnitAmount = unitAmounts.length && unitCueIndex !== undefined
    ? [...unitAmounts].sort((a, b) => Math.abs(a.index - unitCueIndex) - Math.abs(b.index - unitCueIndex))[0]
    : unitAmounts.at(-1)
  const unitPrice = selectedUnitAmount?.value ?? ''
  const unitLabel: ParsedOcr['unitLabel'] = /\bkg\b/i.test(unitLine) ? 'kg' : /\b(?:l|lt)\b/i.test(unitLine) ? 'L' : ''

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
      const productWords = productWordsInLine(layoutLine)
      const line = productWords.length
        ? cleanLine(productWords.map(word => word.text).join(' '))
        : layoutLine.words?.length ? '' : cleanLine(layoutLine.text)
      const wordHeights = productWords?.map(word => word.bbox.y1 - word.bbox.y0) ?? []
      const letters = [...line].filter(character => /\p{L}/u.test(character)).length
      return { line, y: layoutLine.bbox.y0, height: wordHeights.length ? Math.max(...wordHeights) : layoutLine.bbox.y1 - layoutLine.bbox.y0, letters }
    })
    : lines.map((line, index) => ({ line, y: index, height: 1, letters: [...line].filter(character => /\p{L}/u.test(character)).length }))
  const nameCandidates = nameSource
    .filter(candidate => isNameLine(candidate.line))
    .filter(candidate => !/^CONTINENTE(?:\s+BIO)?$/i.test(candidate.line) || nameSource.some(other => other !== candidate && isNameLine(other.line)))
    .sort((a, b) => b.letters - a.letters || b.height - a.height || a.y - b.y)
  const anchor = nameCandidates[0]
  const selectedNames = anchor
    ? nameCandidates.filter(candidate => {
      const nearAnchor = layoutLines.length === 0 || Math.abs(candidate.y - anchor.y) <= anchor.height * 4
      const similarSize = candidate.letters >= anchor.letters * 0.85 && candidate.height >= anchor.height * 0.75
      const continentesTag = nameCandidates.some(line => /\bCONTINENTE\b/i.test(line.line))
      const relatedProductLine = continentesTag
        && candidate.letters >= Math.min(5, anchor.letters * 0.55) && candidate.height >= anchor.height * 0.45
      return nearAnchor && (similarSize || relatedProductLine)
    })
    : []
  const name = (selectedNames.length ? selectedNames : nameCandidates.slice(0, 2))
    .sort((a, b) => a.y - b.y)
    .slice(0, 3)
    .map(candidate => candidate.line)
    .join(' ')

  const inferredPrice = shelfPriceFromUnit(unitPrice, unitLabel, name, layoutLines, text)
  const relativePriceDifference = Math.abs(Number(price) - Number(inferredPrice)) / Math.max(Number(price), Number(inferredPrice))
  const isWholeNumberPartial = Boolean(price) && Number(price) >= 10 && Number.isInteger(Number(price))
  const completePrice = inferredPrice && (!price || isWholeNumberPartial || relativePriceDifference <= 0.25)
    ? inferredPrice
    : price || (unitPrice && unitLabel ? unitPrice : '')
  const explicitUnitCue = /(?:€\s*\/\s*(?:kg|l|lt)\b|\/\s*(?:kg|l|lt)\b|\bper\s*(?:kg|l|lt)\b|\bpor\s*(?:kg|l|lt)\b)/i.test(unitLine)
  const hasPrintedUnitDecimals = /\d+[.,]\d{1,2}\s*(?:€\s*)?\/?\s*(?:kg|l|lt)\b/i.test(unitLine)
  const selectedUnitPrice = explicitUnitCue && !unitPrice && !hasPrintedUnitDecimals && completePrice ? completePrice : unitPrice
  const adjustedUnitPrice = correctUnitPrice(completePrice, selectedUnitPrice, unitLabel, name, layoutLines, text)
  return { name, price: completePrice, unitPrice: adjustedUnitPrice, unitLabel }
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

async function prepareImage(file: File): Promise<{ photo: string; source: HTMLCanvasElement }> {
  const decoded = await loadImage(file)
  try {
    const pixels = decoded.width * decoded.height
    const scale = Math.min(1.25, 2000 / Math.max(decoded.width, decoded.height), Math.sqrt(2_500_000 / pixels))
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

    return { photo: photoCanvas.toDataURL('image/jpeg', 0.88), source }
  } finally {
    decoded.dispose()
  }
}

function makeLabelCrop(source: HTMLCanvasElement): HTMLCanvasElement {
  const crop = document.createElement('canvas')
  crop.width = Math.round(source.width * 0.94)
  crop.height = Math.round(source.height * 0.80)
  const context = crop.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is unavailable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, Math.round(source.width * 0.03), Math.round(source.height * 0.08), crop.width, crop.height, 0, 0, crop.width, crop.height)
  return crop
}

function passScore(pass: OcrPass): number {
  const { name, price, unitPrice } = pass.parsed
  return (name ? 10 : 0) + (price ? 10 : 0) + (unitPrice ? 2 : 0) + Math.max(0, pass.confidence) / 100 + pass.priceHeight / 1000 + pass.nameLength / 1000
}

function sanitizeMergedFields(parsed: ParsedOcr, passes: OcrPass[]): ParsedOcr {
  const result = { ...parsed }
  const packageSize = passes.find(pass => packageSizeFrom(pass.parsed.name, pass.layoutLines))
  const photoSuggestsFreshProduce = passes.some(pass => /(?:\bKG\b|€\s*\/\s*KG)/i.test(pass.text))
    && !passes.some(pass => WEIGHT_TOKEN.test(pass.parsed.name) && !/\b(?:BIO|GM|G)\b/i.test(pass.parsed.name))
  const nameHasEvidence = passes.some(pass => pass.parsed.name === result.name)
  if (!nameHasEvidence) result.name = ''

  const explicitPricePass = passes.find(pass => pass.parsed.price === result.price)
  const geometryPricePass = passes.find(pass => pass.parsed.price === result.price && pass.priceHeight >= 80)
  if (!explicitPricePass && !geometryPricePass) result.price = ''
  const packagePriceEvidence = passes.some(pass => pass.parsed.price && pass.priceHeight >= 80)
  const storeLabel = passes.some(pass => /\bCONTINENTE\b/i.test(pass.text))
  if (result.price && !packagePriceEvidence && !packageSize && Number(result.price) > (storeLabel ? 5 : 50)) result.price = ''
  if (result.price && photoSuggestsFreshProduce && Number(result.price) > 10) result.price = ''

  if (result.unitPrice && !passes.some(pass => pass.parsed.unitPrice === result.unitPrice)) {
    result.unitPrice = ''
  }
  return result
}

export function shouldRetryOcr(passes: readonly (ParsedOcr & { confidence?: number })[]): boolean {
  const complete = passes.some(pass => pass.name.trim().length >= 3 && Boolean(pass.price) && (pass.confidence ?? 0) >= 55)
  return !complete && passes.length < MAX_OCR_PASSES
}

export async function recognizePriceTag(file: File, onProgress: (progress: OcrProgress) => void = () => {}): Promise<PriceTagResult> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um ficheiro de imagem.')
  if (file.size > 20 * 1024 * 1024) throw new Error('A fotografia deve ter menos de 20 MB.')

  const prepared = await prepareImage(file)
  onProgress({ status: 'photo prepared', progress: 0, photo: prepared.photo })
  const passes: OcrPass[] = []
  let worker: OcrWorker | undefined

  const run = async (image: HTMLCanvasElement, psm: typeof PSM.SPARSE_TEXT | typeof PSM.SINGLE_BLOCK) => {
    if (!worker || passes.length >= MAX_OCR_PASSES) return
    const attempt = passes.length + 1
    onProgress({ status: `recognizing text (${attempt}/${MAX_OCR_PASSES})`, progress: 0.1 + (attempt - 1) * 0.3 })
    const result = await withTimeout((async () => {
      await worker!.setParameters({
        tessedit_pageseg_mode: psm,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_char_whitelist: '',
      })
      return worker!.recognize(image, {}, { blocks: true })
    })(), OCR_PASS_TIMEOUT_MS, 'A leitura demorou demasiado; preencha os campos reconhecidos manualmente.')
    const text = result.data.text.trim()
    const layoutLines = result.data.blocks?.flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines)) ?? []
    const parsed = parseOcr(text, layoutLines)
    const priceHeight = Math.max(0, ...amountFromLayoutWords(layoutLines).filter(candidate => candidate.value === parsed.price).map(candidate => candidate.height))
    const nameLength = [...parsed.name].filter(character => /\p{L}/u.test(character)).length + (WEIGHT_TOKEN.test(parsed.name) ? 20 : 0)
    const packageSize = packageSizeFrom(parsed.name, layoutLines)?.[0] ?? ''
    passes.push({ parsed, text, confidence: result.data.confidence ?? 0, priceHeight, nameLength, packageSize, layoutLines })
  }

  const bestPass = () => passes.reduce((current, pass) => passScore(pass) > passScore(current) ? pass : current)
  const shouldContinue = () => shouldRetryOcr(passes.map(pass => ({ ...pass.parsed, confidence: pass.confidence })))

  try {
    worker = await getOcrWorker(message => onProgress({ status: message.status, progress: message.progress, photo: prepared.photo }))
    await run(makeLabelCrop(prepared.source), PSM.SPARSE_TEXT)

    if (shouldContinue()) {
      await run(prepared.source, PSM.SPARSE_TEXT)
    }
  } catch (error) {
    console.warn('OCR stopped; returning partial results:', error)
    if (worker) {
      if (sharedWorkerPromise) sharedWorkerPromise = undefined
      void worker.terminate().catch(() => {})
    }
  }

  if (!passes.length) {
    return { name: '', price: '', unitPrice: '', unitLabel: '', photo: prepared.photo, recognizedText: '', confidence: 0 }
  }

  const best = bestPass()
  const namePass = [...passes].filter(pass => pass.parsed.name)
    .sort((a, b) => b.nameLength - a.nameLength || b.confidence - a.confidence)[0]
  const unitPricePass = [...passes].filter(pass => pass.parsed.unitPrice)
    .sort((a, b) => b.confidence - a.confidence)[0]
  const unitLabelPass = [...passes].filter(pass => pass.parsed.unitLabel)
    .sort((a, b) => b.confidence - a.confidence)[0]
  const candidatePrice = [...passes].flatMap(pass => {
    if (!pass.parsed.price) return []
    const explicitDecimal = pass.text.split(/[\r\n]+/).some(line => amountsIn(line).some(amount =>
      amount.value === pass.parsed.price && /[.,]\d{1,2}/.test(amount.raw),
    ))
    const geometrySupported = pass.priceHeight >= 80
    return explicitDecimal || geometrySupported ? [{ value: pass.parsed.price, explicitDecimal, geometrySupported, confidence: pass.confidence }] : []
  }).sort((a, b) => Number(b.geometrySupported) - Number(a.geometrySupported)
    || Number(b.explicitDecimal) - Number(a.explicitDecimal) || b.confidence - a.confidence)[0]

  const merged: ParsedOcr = {
    name: namePass?.parsed.name ?? best.parsed.name,
    price: candidatePrice?.value ?? best.parsed.price,
    unitPrice: unitPricePass?.parsed.unitPrice || best.parsed.unitPrice,
    unitLabel: unitLabelPass?.parsed.unitLabel || best.parsed.unitLabel,
  }
  Object.assign(merged, sanitizeMergedFields(merged, passes))

  const hasPrintedUnitDecimals = passes.some(pass => pass.parsed.unitLabel
    && new RegExp(`\\d+[.,]\\d{1,2}\\s*(?:€\\s*)?\\/?\\s*(?:${pass.parsed.unitLabel === 'kg' ? 'kg' : 'l|lt'})\\b`, 'i').test(pass.text))
  const hasExplicitUnitCue = passes.some(pass => /(?:€\s*\/\s*(?:kg|l|lt)\b|\/\s*(?:kg|l|lt)\b|\bper\s*(?:kg|l|lt)\b|\bpor\s*(?:kg|l|lt)\b)/i.test(pass.text))
  const isLooseProducePrice = passes.some(pass => /(?:^|\n)\s*(?:€\s*)?\/\s*kg\b/i.test(pass.text))
  if (merged.price && merged.unitLabel && hasExplicitUnitCue && !hasPrintedUnitDecimals && isLooseProducePrice) merged.unitPrice = merged.price

  const packageLayout = passes.find(pass => pass.packageSize)?.layoutLines ?? []
  const inferredPrice = shelfPriceFromUnit(merged.unitPrice, merged.unitLabel, merged.name, packageLayout)
  const relativePriceDifference = Math.abs(Number(merged.price) - Number(inferredPrice)) / Math.max(Number(merged.price), Number(inferredPrice))
  const isWholeNumberPartial = Boolean(merged.price) && Number(merged.price) >= 10 && Number.isInteger(Number(merged.price))
  if (inferredPrice && (!merged.price || isWholeNumberPartial || relativePriceDifference <= 0.25)) merged.price = inferredPrice
  merged.unitPrice = correctUnitPrice(merged.price, merged.unitPrice, merged.unitLabel, merged.name, packageLayout)

  return {
    ...merged,
    photo: prepared.photo,
    recognizedText: passes.map(pass => pass.text).filter(Boolean).join('\n'),
    confidence: best.confidence,
  }
}

export function progressMessage(status: string, progress: number): string {
  if (status.includes('language')) return 'A carregar o modelo de português…'
  if (status.includes('core') || status.includes('worker')) return 'A iniciar o motor de leitura…'
  const attempt = status.match(/recognizing text \((\d+)\/(\d+)\)/)
  if (attempt) return `A ler a etiqueta — tentativa ${attempt[1]} de ${attempt[2]}…`
  if (status.includes('cropping')) return 'A focar a etiqueta para ler melhor…'
  if (status.includes('enhancing')) return 'A melhorar a imagem para ler a etiqueta…'
  if (status.includes('sparse')) return 'A procurar texto em diferentes zonas da etiqueta…'
  if (status.includes('recognizing')) return `A analisar a etiqueta… ${Math.round(progress * 100)}%`
  return 'A preparar a leitura da etiqueta…'
}
