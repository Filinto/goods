import { describe, expect, it } from 'vitest'
import { parseOcr } from './ocr'

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
      name: 'ARROZ CAROLINO',
      price: '1.29',
      unitPrice: '1.79',
      unitLabel: 'kg',
    })
  })

  it('keeps short names and removes the package size', () => {
    expect(parseOcr('LEITE 1L\n1,09')).toEqual({ name: 'LEITE', price: '1.09', unitPrice: '', unitLabel: '' })
  })

  it('parses a currency suffix and both decimal separator conventions', () => {
    expect(parseOcr('QUEIJO FLAMENGO 200 g\n4.50 €\n22,50 €/kg')).toEqual({
      name: 'QUEIJO FLAMENGO',
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
      name: 'CILLIT BANG',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('joins a two-line cleaning-product name and repairs spaced LCD price digits', () => {
    expect(parseOcr('SPRAY BOL&SUID\nCILLIT BANG 500ML\n2 , 59 €\n5,18 €/LT\n5,19 € PVPR\nMENOS 50%\nSOBRE PVP RECOMENDADO')).toEqual({
      name: 'SPRAY BOL SUID CILLIT BANG',
      price: '2.59',
      unitPrice: '5.18',
      unitLabel: 'L',
    })
  })

  it('reads the product, shelf price and per-kilogram price on a pizza tag', () => {
    expect(parseOcr('PIZZA PEPPERONI\nRISTORANTE 320G\n3,79 €\n11,84 €/KG\n4,99€ PVPR')).toEqual({
      name: 'PIZZA PEPPERONI RISTORANTE',
      price: '3.79',
      unitPrice: '11.84',
      unitLabel: 'kg',
    })
  })

  it('reads a loose-price produce tag with the unit on its own line', () => {
    expect(parseOcr('CLEMENTINA\nCONTINENTE\n€/KG\n2,49')).toEqual({
      name: 'CLEMENTINA',
      price: '2.49',
      unitPrice: '2.49',
      unitLabel: 'kg',
    })
  })

  it('does not use a PVPR reference price instead of the large current price', () => {
    expect(parseOcr('COENTROS\nCONTINENTE BIO 30G\n0,99€\n23,00 €/KG')).toEqual({
      name: 'COENTROS',
      price: '0.99',
      unitPrice: '23.00',
      unitLabel: 'kg',
    })
  })

  it('ignores store boilerplate instead of suggesting it as an item name', () => {
    expect(parseOcr('OBRIGADO PELA VISITA\nPVP RECOMENDADO')).toEqual({ name: '', price: '', unitPrice: '', unitLabel: '' })
  })
})
