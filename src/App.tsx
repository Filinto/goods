import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { progressMessage, recognizePriceTag } from './ocr'
import {
  ArrowDownUp, ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, ImagePlus,
  LogOut, Minus, Plus, ScanLine, ShoppingBasket, Sparkles, Trash2, X, CircleHelp,
} from 'lucide-react'
import './App.css'
import './ocr.css'

type Item = { id: string; name: string; price: number; unitPrice: number | null; unitLabel?: 'kg' | 'L' | ''; quantity: number; photo: string }
type Shopping = { id: string; name: string; createdAt: string; completedAt?: string; items: Item[] }
type Profile = { email: string; salt: string; passwordHash: string }
type Review = { name: string; price: string; unitPrice: string; unitLabel: 'kg' | 'L' | ''; quantity: string; photo: string; recognizedText: string }

const SHOPPINGS_KEY = 'basket-shoppings-v1'
const PROFILE_KEY = 'basket-profile-v1'
const SESSION_KEY = 'basket-session-v1'
const money = (value: number) => new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(value)
const readStored = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback } catch { return fallback }
}
const uid = () => crypto.randomUUID()

async function passwordDigest(password: string, salt: string) {
  const value = new TextEncoder().encode(`${salt}:${password}`)
  const result = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}

function App() {
  const [profile, setProfile] = useState<Profile | null>(() => readStored(PROFILE_KEY, null))
  const [email, setEmail] = useState(() => readStored<string | null>(SESSION_KEY, null))
  const [authMode, setAuthMode] = useState<'signup' | 'login'>(() => readStored(PROFILE_KEY, null) ? 'login' : 'signup')
  const [authError, setAuthError] = useState('')
  const [shoppings, setShoppings] = useState<Shopping[]>(() => readStored(SHOPPINGS_KEY, []))
  const [view, setView] = useState<'current' | 'history'>('current')
  const [review, setReview] = useState<Review | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrMessage, setOcrMessage] = useState('A ler a etiqueta de preço…')
  const [toast, setToast] = useState('')
  const [selectedHistory, setSelectedHistory] = useState<Shopping | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try { localStorage.setItem(SHOPPINGS_KEY, JSON.stringify(shoppings)) }
    catch { console.warn('O Cesto não conseguiu guardar os dados da compra. O armazenamento do dispositivo pode estar cheio.') }
  }, [shoppings])
  useEffect(() => { if (email) localStorage.setItem(SESSION_KEY, JSON.stringify(email)); else localStorage.removeItem(SESSION_KEY) }, [email])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const active = shoppings.find(shopping => !shopping.completedAt) ?? null
  const completed = useMemo(() => shoppings.filter(shopping => shopping.completedAt).sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)), [shoppings])
  const total = active?.items.reduce((sum, item) => sum + item.price * item.quantity, 0) ?? 0

  const updateShopping = (id: string, updater: (shopping: Shopping) => Shopping) => {
    setShoppings(previous => previous.map(shopping => shopping.id === id ? updater(shopping) : shopping))
  }

  const handleAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthError('')
    const form = new FormData(event.currentTarget)
    const nextEmail = String(form.get('email') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    if (!nextEmail || password.length < 6) { setAuthError('Introduza um e-mail válido e uma palavra-passe com pelo menos 6 caracteres.'); return }
    if (authMode === 'signup') {
      if (profile) { setAuthError('Já existe uma conta neste dispositivo. Inicie sessão.'); return }
      const salt = crypto.randomUUID()
      const nextProfile = { email: nextEmail, salt, passwordHash: await passwordDigest(password, salt) }
      localStorage.setItem(PROFILE_KEY, JSON.stringify(nextProfile))
      setProfile(nextProfile)
    } else {
      if (!profile || profile.email !== nextEmail || await passwordDigest(password, profile.salt) !== profile.passwordHash) {
        setAuthError('Os dados introduzidos não correspondem à conta neste dispositivo.')
        return
      }
    }
    setEmail(nextEmail)
  }

  const processImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setOcrBusy(true)
    setOcrMessage('A preparar a fotografia…')
    let photo = ''
    try {
      const detected = await recognizePriceTag(file, progress => {
        if (progress.photo) photo = progress.photo
        setOcrMessage(progressMessage(progress.status, progress.progress))
      })
      photo = detected.photo
      setReview({ ...detected, quantity: '1' })
      setToast(detected.name && detected.price ? 'Etiqueta analisada — confirme os dados.' : 'Etiqueta lida parcialmente — confirme e preencha os campos em falta.')
    } catch (error) {
      console.error('OCR falhou:', error)
      if (photo) setReview({ name: '', price: '', unitPrice: '', unitLabel: '', quantity: '1', photo, recognizedText: '' })
      setToast(error instanceof Error ? error.message : 'Não foi possível ler a fotografia. Confirme ou introduza os dados manualmente.')
    } finally { setOcrBusy(false) }
  }

  const confirmItem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!review || !active) return
    const item: Item = {
      id: uid(), name: review.name.trim(), price: Number(review.price),
      unitPrice: review.unitPrice ? Number(review.unitPrice) : null,
      unitLabel: review.unitLabel,
      quantity: Math.max(1, Number.parseInt(review.quantity, 10) || 1), photo: review.photo,
    }
    updateShopping(active.id, shopping => ({ ...shopping, items: [...shopping.items, item] }))
    setReview(null)
    setToast('Artigo adicionado à lista de compras')
  }

  const changeQuantity = (itemId: string, delta: number) => {
    if (!active) return
    updateShopping(active.id, shopping => ({ ...shopping, items: shopping.items.map(item => item.id === itemId ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item) }))
  }

  const removeItem = (itemId: string) => {
    if (!active) return
    updateShopping(active.id, shopping => ({ ...shopping, items: shopping.items.filter(item => item.id !== itemId) }))
  }

  const startShopping = () => {
    const shopping = { id: uid(), name: `Compras de ${new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short' }).format(new Date())}`, createdAt: new Date().toISOString(), items: [] }
    setShoppings(previous => [shopping, ...previous])
    setView('current')
    setToast('Nova lista de compras iniciada')
  }

  const finishShopping = () => {
    if (!active?.items.length) return
    updateShopping(active.id, shopping => ({ ...shopping, completedAt: new Date().toISOString() }))
    setToast('Compras guardadas no histórico')
  }

  if (!email) return <main className="auth-page">
    <div className="auth-art"><div className="brand-mark large"><ShoppingBasket size={34} strokeWidth={2.2} /></div><span className="auth-kicker">Compras mais conscientes</span><h1>Boas compras<br />começam com uma lista.</h1><p>Acompanhe as suas compras, etiqueta a etiqueta.</p><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-sticker"><Sparkles size={17} /> A sua lista, sempre sob controlo</div></div>
    <section className="auth-panel"><div className="mobile-brand"><div className="brand-mark"><ShoppingBasket size={22} /></div><span>Cesto</span></div><div className="auth-copy"><span className="eyebrow">BEM-VINDO AO CESTO</span><h2>{authMode === 'signup' ? 'Criar conta' : 'Bem-vindo de volta'}</h2><p>{authMode === 'signup' ? 'Comece a acompanhar as suas compras de forma simples.' : 'Inicie sessão para continuar de onde ficou.'}</p></div><form className="auth-form" onSubmit={handleAuth}><label>Endereço de e-mail<input name="email" type="email" placeholder="voce@exemplo.com" autoComplete="email" required /></label><label>Palavra-passe<input name="password" type="password" placeholder="Pelo menos 6 caracteres" minLength={6} autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} required /></label>{authError && <p className="form-error">{authError}</p>}<button className="primary-button full-button" type="submit">{authMode === 'signup' ? 'Criar conta' : 'Iniciar sessão'}<ArrowRight size={17} /></button></form><p className="auth-switch">{authMode === 'signup' ? 'Já tem uma conta?' : 'Ainda não conhece o Cesto?'} <button onClick={() => { setAuthMode(authMode === 'signup' ? 'login' : 'signup'); setAuthError('') }}>{authMode === 'signup' ? 'Iniciar sessão' : 'Criar conta'}</button></p><div className="local-note"><CircleHelp size={15} /> Conta de demonstração guardada apenas neste dispositivo.</div></section>
  </main>

  return <div className="app-shell">
    <header className="topbar"><div className="topbar-inner"><button className="brand" onClick={() => { setView('current'); setSelectedHistory(null) }}><span className="brand-mark"><ShoppingBasket size={21} strokeWidth={2.2} /></span><span>Cesto</span></button><nav className="desktop-nav" aria-label="Navegação principal"><button className={view === 'current' ? 'nav-link active' : 'nav-link'} onClick={() => { setView('current'); setSelectedHistory(null) }}>As minhas compras</button><button className={view === 'history' ? 'nav-link active' : 'nav-link'} onClick={() => { setView('history'); setSelectedHistory(null) }}>Histórico <span className="nav-count">{completed.length}</span></button></nav><div className="user-menu"><button className="help-button" aria-label="Como funciona o Cesto" onClick={() => setShowHelp(true)}><CircleHelp size={19} /></button><div className="avatar">{email?.slice(0, 1).toUpperCase()}</div><span className="user-email">{email}</span><button className="logout-button" aria-label="Terminar sessão" onClick={() => setEmail(null)}><LogOut size={17} /></button></div></div></header>
    <main className="main-content">
      <div className="mobile-tabs"><button className={view === 'current' ? 'selected' : ''} onClick={() => { setView('current'); setSelectedHistory(null) }}>As minhas compras</button><button className={view === 'history' ? 'selected' : ''} onClick={() => { setView('history'); setSelectedHistory(null) }}>Histórico <span>{completed.length}</span></button></div>
      {view === 'current' ? <>
        <section className="page-heading"><div><span className="eyebrow"><span className="live-dot" /> A SUA LISTA, EM TEMPO REAL</span><h1>{active ? 'As minhas compras' : 'Pronto para começar?'}</h1><p>{active ? 'Tenha uma visão clara do que vai levar.' : 'Crie uma lista e mantenha a próxima compra sob controlo.'}</p></div>{active && <div className="date-chip"><Clock3 size={15} /> Iniciada {new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short' }).format(new Date(active.createdAt))}</div>}</section>
        {!active ? <section className="empty-card"><div className="empty-illustration"><ShoppingBasket size={37} strokeWidth={1.5} /><span><Plus size={16} /></span></div><h2>A próxima compra começa aqui</h2><p>Crie uma lista nova e digitalize as etiquetas à medida que avança.</p><button className="primary-button" onClick={startShopping}>Criar lista de compras <ArrowRight size={17} /></button></section> : <div className="shopping-layout">
          <section className="list-panel"><div className="list-heading"><div><span className="section-label">LISTA ATUAL</span><h2>{active.name}</h2></div><button className="subtle-button" onClick={() => setShowHelp(true)}><CircleHelp size={16} /> Como funciona</button></div>
            {active.items.length ? <div className="item-list">{active.items.map((item, index) => <article className="item-row" key={item.id}><div className="item-photo-wrap"><img className="item-photo" src={item.photo} alt={`Etiqueta de ${item.name}`} /><span className="item-index">{String(index + 1).padStart(2, '0')}</span></div><div className="item-info"><h3>{item.name}</h3><div className="item-meta">{item.unitPrice !== null && <span>{money(item.unitPrice)} / {item.unitLabel === 'L' ? 'L' : 'kg'}</span>}<span className="verified"><CheckCircle2 size={13} /> Confirmado</span></div></div><div className="quantity-control"><button aria-label={`Diminuir quantidade de ${item.name}`} onClick={() => changeQuantity(item.id, -1)}><Minus size={14} /></button><span>{item.quantity}</span><button aria-label={`Aumentar quantidade de ${item.name}`} onClick={() => changeQuantity(item.id, 1)}><Plus size={14} /></button></div><strong className="item-total">{money(item.price * item.quantity)}</strong><button className="remove-button" aria-label={`Remover ${item.name}`} onClick={() => removeItem(item.id)}><Trash2 size={16} /></button></article>)}</div> : <div className="list-empty"><span className="empty-scan-icon"><ScanLine size={22} /></span><div><h3>A lista está vazia</h3><p>Digitalize uma etiqueta de preço para adicionar o primeiro artigo.</p></div></div>}
            <button className="scan-button" disabled={ocrBusy} onClick={() => fileInput.current?.click()}><ImagePlus size={19} /><span><strong>{active.items.length ? 'Digitalizar outro artigo' : 'Digitalizar etiqueta de preço'}</strong><small>Use a câmara ou escolha uma fotografia</small></span><ArrowRight size={18} className="scan-arrow" /></button><input ref={fileInput} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={processImage} />
            <div className="privacy-note"><span><Check size={14} /></span>As fotografias ficam guardadas neste dispositivo, juntamente com a lista.</div>
          </section>
          <aside className="summary-card"><div className="summary-top"><span className="section-label">TOTAL ESTIMADO</span><div className="summary-total">{money(total)}</div><p>{active.items.length === 0 ? 'O total será apresentado aqui' : `${active.items.length} ${active.items.length === 1 ? 'artigo' : 'artigos'} na lista`}</p></div><div className="summary-line"><span>Subtotal dos artigos</span><strong>{money(total)}</strong></div><div className="summary-line muted"><span>Promoções e descontos</span><span>Não incluídos</span></div><div className="summary-footnote"><Sparkles size={15} /><span>Uma estimativa útil para controlar os gastos.</span></div><button className="complete-button" disabled={!active.items.length} onClick={finishShopping}>Concluir compras <Check size={17} /></button><span className="complete-hint">Esta lista ficará disponível no histórico.</span></aside>
        </div>}
        {active && <div className="bottom-total"><div><span>ESTIMATIVA TOTAL</span><strong>{money(total)}</strong></div><button onClick={finishShopping} disabled={!active.items.length}>Concluir <Check size={16} /></button></div>}
      </> : <section className="history-page"><div className="page-heading history-heading"><div><span className="eyebrow">AS SUAS COMPRAS ANTERIORES</span><h1>{selectedHistory ? selectedHistory.name : 'Histórico de compras'}</h1><p>{selectedHistory ? 'Consulte os artigos que comprou.' : 'Todas as compras concluídas, num só lugar.'}</p></div>{selectedHistory && <button className="subtle-button back-button" onClick={() => setSelectedHistory(null)}><ArrowLeft size={16} /> Todas as compras</button>}</div>{selectedHistory ? <HistoryDetail shopping={selectedHistory} /> : completed.length ? <div className="history-grid">{completed.map(shopping => <button className="history-card" key={shopping.id} onClick={() => setSelectedHistory(shopping)}><div className="history-card-top"><span className="history-icon"><ShoppingBasket size={19} /></span><span className="history-date">{new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(shopping.completedAt!))}</span><ArrowRight size={17} className="history-arrow" /></div><h2>{shopping.name}</h2><div className="history-card-bottom"><span>{shopping.items.length} {shopping.items.length === 1 ? 'artigo' : 'artigos'}</span><strong>{money(shopping.items.reduce((sum, item) => sum + item.price * item.quantity, 0))}</strong></div><div className="history-preview">{shopping.items.slice(0, 4).map(item => <img src={item.photo} alt="" key={item.id} />)}{shopping.items.length > 4 && <span>+{shopping.items.length - 4}</span>}</div></button>)}</div> : <div className="empty-card history-empty"><div className="empty-illustration"><Clock3 size={34} strokeWidth={1.5} /></div><h2>Ainda não existem compras anteriores</h2><p>As listas concluídas serão apresentadas aqui.</p><button className="primary-button" onClick={() => { if (!active) startShopping(); else setView('current') }}>Ir para as minhas compras <ArrowRight size={17} /></button></div>}</section>}
    </main>
    <footer className="app-footer"><span>Pequenos passos, compras mais conscientes.</span><span>Feito para as suas compras do dia a dia <span className="footer-heart">♥</span></span></footer>

    {ocrBusy && <div className="overlay"><div className="scan-loading"><div className="scan-spinner"><ScanLine size={27} /></div><h2>Só um momento</h2><p>{ocrMessage}</p><div className="loading-track"><span /></div></div></div>}
    {review && <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) setReview(null) }}><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="modal-header"><div><span className="eyebrow"><Sparkles size={13} /> ETIQUETA DIGITALIZADA</span><h2 id="review-title">Confirme o artigo</h2><p>Analisámos a etiqueta. Confirme se os dados estão corretos.</p></div><button className="close-button" aria-label="Fechar" onClick={() => setReview(null)}><X size={20} /></button></div><div className="review-photo"><img src={review.photo} alt="Fotografia da etiqueta de preço" /><div className="photo-scanned"><CheckCircle2 size={14} /> Fotografia captada</div></div>{review.recognizedText && <details className="ocr-transcript"><summary>Ver texto reconhecido</summary><pre>{review.recognizedText}</pre></details>}<form onSubmit={confirmItem}><label>Nome do artigo<input autoFocus value={review.name} placeholder="ex.: leite gordo biológico" onChange={event => setReview({ ...review, name: event.target.value })} required /></label><div className="review-fields"><label>Preço<input type="number" min="0.01" step="0.01" inputMode="decimal" value={review.price} placeholder="0,00" onChange={event => setReview({ ...review, price: event.target.value })} required /></label><label>Preço por {review.unitLabel || 'kg/L'} <span className="optional">Opcional</span><input type="number" min="0.01" step="0.01" inputMode="decimal" value={review.unitPrice} placeholder="0,00" onChange={event => setReview({ ...review, unitPrice: event.target.value })} /></label></div><label>Quantidade<input type="number" min="1" step="1" inputMode="numeric" value={review.quantity} onChange={event => setReview({ ...review, quantity: event.target.value })} required /></label><div className="review-actions"><button type="button" className="retake-button" onClick={() => { setReview(null); fileInput.current?.click() }}><ArrowDownUp size={16} /> Tirar outra fotografia</button><button className="primary-button" type="submit">Confirmar artigo <Check size={16} /></button></div></form><p className="review-tip"><CircleHelp size={14} /> Pode alterar os dados antes de adicionar o artigo.</p></section></div>}
    {showHelp && <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) setShowHelp(false) }}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="close-button help-close" aria-label="Fechar" onClick={() => setShowHelp(false)}><X size={20} /></button><span className="help-icon"><ScanLine size={25} /></span><span className="eyebrow">GUIA RÁPIDO</span><h2 id="help-title">Compras simples e organizadas.</h2><div className="help-steps"><div><span>01</span><p><strong>Fotografe uma etiqueta de preço</strong>Use a câmara do telemóvel ou escolha uma fotografia.</p></div><div><span>02</span><p><strong>Confirme os dados</strong>Verifique os dados reconhecidos e corrija o que for necessário.</p></div><div><span>03</span><p><strong>Acompanhe o total</strong>Os artigos confirmados são adicionados ao total estimado.</p></div></div><button className="primary-button full-button" onClick={() => setShowHelp(false)}>Percebi <Check size={16} /></button></section></div>}
    {toast && <div className="toast"><CheckCircle2 size={17} /> {toast}</div>}
  </div>
}

function HistoryDetail({ shopping }: { shopping: Shopping }) {
  const total = shopping.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  return <div className="history-detail"><div className="detail-summary"><span className="section-label">CONCLUÍDAS {new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(shopping.completedAt!)).toUpperCase()}</span><strong>{money(total)}</strong><span>total final da lista</span></div><div className="detail-items">{shopping.items.map(item => <div className="detail-item" key={item.id}><img src={item.photo} alt={`Etiqueta de ${item.name}`} /><div><strong>{item.name}</strong><span>Qtd. {item.quantity}{item.unitPrice !== null ? ` · ${money(item.unitPrice)} / ${item.unitLabel === 'L' ? 'L' : 'kg'}` : ''}</span></div><strong>{money(item.price * item.quantity)}</strong></div>)}</div></div>
}

export default App
