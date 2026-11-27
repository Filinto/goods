import { describe, expect, it } from 'vitest'
import { parseOcr, shouldRetryOcr } from './ocr'

describe('parseOcr', () => {
  it('extracts product, shelf price and unit price from a Portuguese label', () => {
    expect(parseOcr('LEITE GORDO BIO\n0,99 €\n2,99 €/kg')).toEqual({
      name: 'LEITE GORDO BIO',
      price: '0.99',
      unitPrice: '2.99',
      unitLabel: 'kg',
    })
  })

  it('does not confuse package weight with the price per kilogram', () => {
    expect(parseOcr('ARROZ CAROLINO 1 kg\n€/kg 1,79\n1,29 €')).toEqual({
      name: 'ARROZ CAROLINO 1 kg',
      price: '1.29',
      unitPrice: '1.79',
      unitLabel: 'kg',
    })
  })

  it('keeps short names together with the package size', () => {
    expect(parseOcr('LEITE 1L\n1,09')).toEqual({ name: 'LEITE 1L', price: '1.09', unitPrice: '', unitLabel: '' })
  })

  it('parses a currency suffix and both decimal separator conventions', () => {
    expect(parseOcr('QUEIJO FLAMENGO 200 g\n4.50 €\n22,50 €/kg')).toEqual({
      name: 'QUEIJO FLAMENGO 200 g',
      price: '4.50',
      unitPrice: '22.50',
      unitLabel: 'kg',
    })
  })

  it('parses thousands separators without treating the amount as a package weight', () => {
    expect(parseOcr('AZEITE VIRGEM EXTRA\n1.299,90 €')).toEqual({
      name: 'AZEITE VIRGEM EXTRA',
      price: '1299.90',
      unitPrice: '',
      unitLabel: '',
    })
  })

  it('does not select promotional text as the product name', () => {
    expect(parseOcr('PROMOÇÃO\nPOUPANÇA 20%\nCAFÉ MOÍDO\n3,49 €')).toEqual({
      name: 'CAFÉ MOÍDO',
      price: '3.49',
      unitPrice: '',
      unitLabel: '',
    })
  })

  it('ignores a recommended retail price and reads the actual shelf price', () => {
    expect(parseOcr('CILLIT BANG 500ML\n2,59 €\n5,18 €/LT\n5,19 € PVPR\nMENOS 50%\nSOBRE PVP RECOMENDADO')).toEqual({
      name: 'CILLIT BANG 500ML',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('matches the supplied Cillit Bang label including package size and ampersand', () => {
    expect(parseOcr('SPRAY BOL&SUJID\nCILLIT BANG 500ML\n2 , 59 €\n5,18 €/LT\n5,19 € PVPR\nMENOS 50%\nSOBRE PVP RECOMENDADO')).toEqual({
      name: 'SPRAY BOL&SUJID CILLIT BANG 500ML',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('reconstructs the split large price digits from the supplied photo OCR boxes', () => {
    const layout = [
      {
        text: '— CILLIT BANG 500ML 5 0 o,',
        bbox: { x0: 448, y0: 699, x1: 2327, y1: 920 },
        words: [
          { text: 'CILLIT', bbox: { x0: 507, y0: 699, x1: 747, y1: 765 } },
          { text: 'BANG', bbox: { x0: 770, y0: 700, x1: 986, y1: 766 } },
          { text: '500ML', bbox: { x0: 1016, y0: 702, x1: 1265, y1: 770 } },
          { text: '5', bbox: { x0: 1941, y0: 733, x1: 2077, y1: 918 } },
          { text: '0', bbox: { x0: 2104, y0: 735, x1: 2238, y1: 920 } },
          { text: 'o,', bbox: { x0: 2262, y0: 744, x1: 2327, y1: 782 } },
        ],
      },
      {
        text: '= 2 , 5 9 hs RECOMENDADO |',
        bbox: { x0: 0, y0: 903, x1: 2792, y1: 1300 },
        words: [
          { text: '2', bbox: { x0: 531, y0: 903, x1: 798, y1: 1300 } },
          { text: ',', bbox: { x0: 837, y0: 1038, x1: 886, y1: 1107 } },
          { text: '5', bbox: { x0: 911, y0: 918, x1: 1036, y1: 1082 } },
          { text: '9', bbox: { x0: 1060, y0: 919, x1: 1172, y1: 1083 } },
          { text: 'RECOMENDADO', bbox: { x0: 1935, y0: 988, x1: 2361, y1: 1071 } },
        ],
      },
      {
        text: '518 €/LT',
        bbox: { x0: 1319, y0: 1207, x1: 1661, y1: 1344 },
        words: [
          { text: '518', bbox: { x0: 1319, y0: 1237, x1: 1450, y1: 1299 } },
          { text: '€/LT', bbox: { x0: 1479, y0: 1231, x1: 1661, y1: 1294 } },
        ],
      },
    ]

    expect(parseOcr('CILLIT BANG 500ML 5 0 o,\n2 , 5 9 hs RECOMENDADO\n518 €/LT', layout)).toEqual({
      name: 'CILLIT BANG 500ML',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('infers the decimal when OCR drops the comma beside the oversized leading digit', () => {
    const layout = [
      {
        text: '2 59€',
        bbox: { x0: 109, y0: 112, x1: 994, y1: 526 },
        words: [
          { text: '2', bbox: { x0: 109, y0: 112, x1: 369, y1: 526 } },
          { text: '59€', bbox: { x0: 428, y0: 127, x1: 994, y1: 324 } },
        ],
      },
      {
        text: '5,18 £/LT',
        bbox: { x0: 933, y0: 455, x1: 1289, y1: 641 },
        words: [
          { text: '5,18', bbox: { x0: 933, y0: 461, x1: 1069, y1: 523 } },
          { text: '£/LT', bbox: { x0: 1100, y0: 455, x1: 1289, y1: 519 } },
        ],
      },
    ]

    expect(parseOcr('2 59€\n5,18 £/LT', layout)).toMatchObject({ price: '2.59', unitPrice: '5.18', unitLabel: 'L' })
  })

  it('reconstructs the price when the large leading digit and cents are on separate OCR rows', () => {
    const layout = [
      { text: 'CLEMENTINA', bbox: { x0: 100, y0: 20, x1: 500, y1: 80 } },
      { text: '2', bbox: { x0: 100, y0: 100, x1: 450, y1: 520 }, words: [{ text: '2', bbox: { x0: 100, y0: 100, x1: 450, y1: 520 } }] },
      { text: '49', bbox: { x0: 600, y0: 125, x1: 1050, y1: 390 }, words: [{ text: '49', bbox: { x0: 600, y0: 125, x1: 1050, y1: 390 } }] },
    ]

    expect(parseOcr('CLEMENTINA\n€/KG\n2\n49', layout)).toMatchObject({
      name: 'CLEMENTINA',
      price: '2.49',
      unitPrice: '2.49',
      unitLabel: 'kg',
    })
  })

  it('uses the largest printed amount as shelf price when smaller reference prices are present', () => {
    const layout = [
      { text: '5,19 € PVPR', bbox: { x0: 0, y0: 50, x1: 120, y1: 68 } },
      { text: '2,59 €', bbox: { x0: 0, y0: 100, x1: 240, y1: 184 } },
      { text: '5,18 €/LT', bbox: { x0: 0, y0: 200, x1: 130, y1: 220 } },
    ]
    expect(parseOcr('5,19 € PVPR\n2,59 €\n5,18 €/LT', layout)).toEqual({
      name: '',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('distinguishes a large shelf price from a smaller PVPR on the same OCR line', () => {
    const layout = [
      { text: '2,59 € 5,19 € PVPR', bbox: { x0: 0, y0: 0, x1: 300, y1: 90 }, words: [
        { text: '2,59', bbox: { x0: 0, y0: 0, x1: 150, y1: 86 } },
        { text: '€', bbox: { x0: 150, y0: 45, x1: 170, y1: 85 } },
        { text: '5,19', bbox: { x0: 190, y0: 55, x1: 250, y1: 74 } },
        { text: '€', bbox: { x0: 252, y0: 57, x1: 265, y1: 74 } },
        { text: 'PVPR', bbox: { x0: 267, y0: 57, x1: 300, y1: 74 } },
      ] },
      { text: '5,18 €/LT', bbox: { x0: 0, y0: 100, x1: 140, y1: 120 } },
    ]
    expect(parseOcr('2,59 € 5,19 € PVPR\n5,18 €/LT', layout)).toMatchObject({
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('selects the largest product-name text and ignores smaller unrelated label text', () => {
    const layout = [
      { text: 'OFERTA', bbox: { x0: 0, y0: 0, x1: 50, y1: 12 } },
      { text: 'SPRAY BOL&SUJID', bbox: { x0: 0, y0: 20, x1: 220, y1: 52 } },
      { text: 'CILLIT BANG 500ML', bbox: { x0: 0, y0: 58, x1: 260, y1: 88 } },
      { text: '2,59 €', bbox: { x0: 0, y0: 110, x1: 250, y1: 195 } },
      { text: '5,18 €/LT', bbox: { x0: 0, y0: 205, x1: 130, y1: 225 } },
      { text: 'MENOS 50%', bbox: { x0: 0, y0: 230, x1: 100, y1: 250 } },
    ]
    expect(parseOcr('OFERTA\nSPRAY BOL&SUJID\nCILLIT BANG 500ML\n2,59 €\n5,18 €/LT\nMENOS 50%', layout)).toMatchObject({
      name: 'SPRAY BOL&SUJID CILLIT BANG 500ML',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('reads the product, shelf price and per-kilogram price on a pizza tag', () => {
    expect(parseOcr('PIZZA PEPPERONI\nRISTORANTE 320G\n3,79 €\n11,84 €/KG\n4,99€ PVPR')).toEqual({
      name: 'PIZZA PEPPERONI',
      price: '3.79',
      unitPrice: '11.84',
      unitLabel: 'kg',
    })
  })

  it('restores a missing large whole-number digit from unit price and package size', () => {
    expect(parseOcr('PIZZA PEPPERONI\nRISTORANTE 320G\n79€\n11,84 €/KG')).toEqual({
      name: 'PIZZA PEPPERONI',
      price: '3.79',
      unitPrice: '11.84',
      unitLabel: 'kg',
    })
  })

  it('reads a loose-price produce tag with the unit on its own line', () => {
    expect(parseOcr('CLEMENTINA\nCONTINENTE\n€/KG\n2,49')).toEqual({
      name: 'CLEMENTINA CONTINENTE',
      price: '2.49',
      unitPrice: '2.49',
      unitLabel: 'kg',
    })
  })

  it('reads a yellow Continente BIO shelf tag with adjacent package and unit-price lines', () => {
    expect(parseOcr('COENTROS\nCONTINENTE BIO 30G\n0,99€\n23,00\n€/KG')).toEqual({
      name: 'COENTROS CONTINENTE BIO 30G',
      price: '0.99',
      unitPrice: '23.00',
      unitLabel: 'kg',
    })
  })

  it('parses the complete expected name and prices for the second supplied photo', () => {
    expect(parseOcr('COENTROS\nCONTINENTE BIO 30G\n0,99 €\n33,00 €/KG')).toEqual({
      name: 'COENTROS CONTINENTE BIO 30G',
      price: '0.99',
      unitPrice: '33.00',
      unitLabel: 'kg',
    })
  })

  it('keeps a shelf price but leaves the unit price blank when OCR did not read it', () => {
    expect(parseOcr('COENTROS\nCONTINENTE BIO 30G\n0,99€\nKG')).toEqual({
      name: 'COENTROS CONTINENTE BIO 30G',
      price: '0.99',
      unitPrice: '',
      unitLabel: 'kg',
    })
  })

  it('ignores store boilerplate instead of suggesting it as an item name', () => {
    expect(parseOcr('OBRIGADO PELA VISITA\nPVP RECOMENDADO')).toEqual({ name: '', price: '', unitPrice: '', unitLabel: '' })
  })
})

describe('OCR retry policy', () => {
  it('stops as soon as the product name and shelf price are available', () => {
    expect(shouldRetryOcr([{ name: 'LEITE GORDO', price: '0.99', unitPrice: '', unitLabel: '', confidence: 78 }])).toBe(false)
    expect(shouldRetryOcr([{ name: 'LEITE GORDO', price: '0.99', unitPrice: '', unitLabel: '', confidence: 42 }])).toBe(true)
  })

  it('allows partial results one more pass, but never exceeds two passes', () => {
    expect(shouldRetryOcr([{ name: 'LEITE GORDO', price: '', unitPrice: '', unitLabel: '', confidence: 80 }])).toBe(true)
    expect(shouldRetryOcr([
      { name: '', price: '0.99', unitPrice: '', unitLabel: '', confidence: 50 },
    ])).toBe(true)
    expect(shouldRetryOcr([
      { name: '', price: '', unitPrice: '', unitLabel: '', confidence: 80 },
      { name: '', price: '', unitPrice: '', unitLabel: '', confidence: 80 },
    ])).toBe(false)
  })
})
