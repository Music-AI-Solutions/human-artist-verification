import React, { useMemo, useState } from 'react'

const WORLD_ID_APP_ID = import.meta.env.VITE_WORLD_ID_APP_ID || 'app_xxxxx'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
const VERIFY_ACTION = 'verify-artist'
const DEMO_WALLET = '0x0000000000000000000000000000000000000a71'

function shortAddress(address) {
  if (!address) return 'Not connected'
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(expiresAt * 1000))
}

function demoProof(rpContext) {
  return {
    merkle_root: `demo-root-${Date.now()}`,
    nullifier_hash: `demo-nullifier-${crypto.randomUUID()}`,
    proof: rpContext || 'demo-proof',
    verification_level: 'orb',
    credential_type: 'orb',
    action: VERIFY_ACTION,
    signal: 'human-artist-verification',
  }
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body.detail === 'string' ? body.detail : body.detail?.message
    throw new Error(message || `Request failed: ${response.status}`)
  }
  return body
}

function IDKitRequestWidget({ appId, action, rpContext, disabled, handleVerify, onSuccess, onError }) {
  const [pending, setPending] = useState(false)

  async function runVerification() {
    setPending(true)
    try {
      const proof = demoProof(rpContext)
      await handleVerify(proof)
      await onSuccess(proof)
    } catch (err) {
      onError(err)
    } finally {
      setPending(false)
    }
  }

  return (
    <button className="primary" disabled={disabled || pending} onClick={runVerification}>
      {pending ? 'Verifying with World ID…' : `Verify Human Artist (${appId}, ${action})`}
    </button>
  )
}

function Step({ number, title, state, children }) {
  return (
    <article className={`step ${state}`}>
      <div className="step-heading">
        <span>{number}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </article>
  )
}

export default function App() {
  const [wallet, setWallet] = useState('')
  const [proof, setProof] = useState(null)
  const [rpContext, setRpContext] = useState('')
  const [certificate, setCertificate] = useState('HAV-CERT-DEMO-001')
  const [download, setDownload] = useState(null)
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [isOnboarded, setIsOnboarded] = useState(false)
  const [busyAction, setBusyAction] = useState('')

  const hasWallet = Boolean(wallet)
  const hasProof = Boolean(proof)
  const canVerify = Boolean(hasWallet && rpContext && certificate)
  const canDownload = useMemo(
    () => Boolean(hasWallet && hasProof && isOnboarded && certificate),
    [certificate, hasProof, hasWallet, isOnboarded],
  )

  function pushEvent(message) {
    setEvents((current) => [{ id: crypto.randomUUID(), message, at: new Date().toISOString() }, ...current])
  }

  async function connectWallet() {
    setError('')
    if (!window.ethereum) {
      setWallet(DEMO_WALLET)
      const nonceResponse = await apiFetch(`/wallet/nonce?wallet=${encodeURIComponent(DEMO_WALLET)}`, { method: 'POST' })
      await apiFetch('/wallet/verify', {
        method: 'POST',
        body: JSON.stringify({
          wallet: DEMO_WALLET,
          nonce: nonceResponse.nonce,
          signature: `demo-signature-${crypto.randomUUID()}`,
        }),
      })
      pushEvent('Demo wallet connected and verified because no injected wallet was found.')
      return DEMO_WALLET
    }

    const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' })
    setWallet(address)

    const nonceResponse = await apiFetch(`/wallet/nonce?wallet=${encodeURIComponent(address)}`, { method: 'POST' })
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [nonceResponse.nonce, address],
    })
    await apiFetch('/wallet/verify', {
      method: 'POST',
      body: JSON.stringify({ wallet: address, nonce: nonceResponse.nonce, signature }),
    })
    pushEvent('Wallet signature verified.')
    return address
  }

  async function requestWorldIdContext(activeWallet = wallet) {
    const response = await apiFetch('/worldid/sign', {
      method: 'POST',
      body: JSON.stringify({ wallet: activeWallet, certificate, action: VERIFY_ACTION }),
    })
    setRpContext(response.rp_context)
    pushEvent('Received signed World ID request context.')
    return response.rp_context
  }

  async function verifyOnBackend(nextProof) {
    setError('')
    const response = await apiFetch('/worldid/verify', {
      method: 'POST',
      body: JSON.stringify(nextProof),
    })
    setProof(nextProof)
    pushEvent(`World ID verified with nullifier ${response.nullifier_hash}.`)
  }

  async function unlockFeature(nextProof = proof) {
    setError('')
    const activeWallet = wallet || (await connectWallet())
    const onboarded = await apiFetch('/artist/onboard', {
      method: 'POST',
      body: JSON.stringify({ proof: nextProof, wallet: activeWallet, certificate }),
    })
    setIsOnboarded(onboarded.onboarded)
    pushEvent(`Artist onboarding complete for ${shortAddress(onboarded.wallet)}.`)
  }

  async function handleDownload() {
    try {
      setError('')
      setBusyAction('download')
      const owner = wallet || (await connectWallet())
      const response = await apiFetch(
        `/gated/download?owner=${encodeURIComponent(owner)}&contract=${encodeURIComponent('0xHAVAtmos')}&token_id=1`,
      )
      setDownload(response)
      pushEvent('Issued short-lived signed Atmos download URL.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  function handleCertificateChange(event) {
    setCertificate(event.target.value)
    setIsOnboarded(false)
    setDownload(null)
  }

  async function startFlow() {
    try {
      setError('')
      setBusyAction('connect')
      const activeWallet = await connectWallet()
      await requestWorldIdContext(activeWallet)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Music AI Solutions Journey · May 18, 2026</p>
        <h1>Human Artist Verification + World ID</h1>
        <p>
          A polished verification journey for human artists: connect a wallet, bind a World ID proof to a
          HAV certificate, and unlock a short-lived Dolby Atmos master download.
        </p>
      </section>

      <section className="summary card">
        <div>
          <span>Wallet</span>
          <strong>{shortAddress(wallet)}</strong>
        </div>
        <div>
          <span>World ID</span>
          <strong>{hasProof ? 'Verified' : 'Pending'}</strong>
        </div>
        <div>
          <span>Onboarding</span>
          <strong>{isOnboarded ? 'Complete' : 'Not started'}</strong>
        </div>
        <div>
          <span>Download</span>
          <strong>{download ? 'Signed URL ready' : 'Locked'}</strong>
        </div>
      </section>

      <section className="card grid">
        <Step number="1" title="Wallet + certificate" state={hasWallet ? 'complete' : 'pending'}>
          <p>Connect an injected wallet or use the built-in demo wallet in environments without MetaMask.</p>
          <button disabled={busyAction === 'connect'} onClick={startFlow}>
            {busyAction === 'connect' ? 'Preparing…' : 'Connect wallet and prepare World ID'}
          </button>
          <label>
            HAV certificate
            <input value={certificate} onChange={handleCertificateChange} />
          </label>
          <p className="meta">Wallet: {shortAddress(wallet)}</p>
        </Step>

        <Step number="2" title="World ID + onboarding" state={isOnboarded ? 'complete' : hasProof ? 'active' : 'pending'}>
          <p>Submit the proof to the backend and immediately onboard the artist with the wallet + HAV certificate.</p>
          <IDKitRequestWidget
            appId={WORLD_ID_APP_ID}
            action={VERIFY_ACTION}
            rpContext={rpContext}
            disabled={!canVerify}
            handleVerify={verifyOnBackend}
            onSuccess={unlockFeature}
            onError={(err) => setError(err.message)}
          />
          {!canVerify && <p className="hint">Connect a wallet and request context before verifying.</p>}
          <p className="meta">Proof: {proof ? proof.nullifier_hash : 'Not verified'}</p>
        </Step>

        <Step number="3" title="Gated Atmos download" state={download ? 'complete' : canDownload ? 'active' : 'pending'}>
          <p>After onboarding succeeds, issue a five-minute signed URL for the protected Atmos master.</p>
          <button className="primary" disabled={!canDownload || busyAction === 'download'} onClick={handleDownload}>
            {busyAction === 'download' ? 'Signing URL…' : 'Download Atmos Master'}
          </button>
          {download && (
            <a href={download.download_url} rel="noreferrer">
              Signed URL expires {formatExpiry(download.expires_at)}
            </a>
          )}
        </Step>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="card audit">
        <h2>Audit trail</h2>
        {events.length === 0 ? (
          <p className="meta">Events will appear here as the journey progresses.</p>
        ) : (
          <ul>
            {events.map((event) => (
              <li key={event.id}>
                <time>{event.at}</time> {event.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <style>{`
        body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
        .shell { max-width: 1120px; margin: 0 auto; padding: 48px 24px; }
        .hero { margin-bottom: 32px; }
        .hero p:last-child { max-width: 760px; color: #cbd5e1; font-size: 1.1rem; }
        .eyebrow { color: #67e8f9; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        h1 { font-size: clamp(2.5rem, 7vw, 5rem); line-height: 0.95; margin: 0 0 16px; }
        h2 { margin: 0; }
        .card { background: rgba(15, 23, 42, 0.82); border: 1px solid rgba(148, 163, 184, 0.24); border-radius: 24px; padding: 24px; box-shadow: 0 20px 80px rgba(8, 13, 30, 0.45); }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 20px; }
        .summary div { border-radius: 18px; background: rgba(2, 6, 23, 0.55); padding: 16px; }
        .summary span { display: block; color: #94a3b8; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; }
        .summary strong { display: block; margin-top: 8px; font-size: 1.05rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
        .step { border-radius: 20px; background: rgba(2, 6, 23, 0.42); border: 1px solid rgba(148, 163, 184, 0.18); padding: 20px; }
        .step.complete { border-color: rgba(34, 211, 238, 0.65); }
        .step.active { border-color: rgba(167, 139, 250, 0.75); }
        .step-heading { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
        .step-heading span { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 999px; background: linear-gradient(135deg, #22d3ee, #a78bfa); color: #020617; font-weight: 900; }
        button, input { border-radius: 999px; border: 0; padding: 12px 18px; font: inherit; }
        button { cursor: pointer; background: #e2e8f0; color: #0f172a; font-weight: 800; }
        button.primary { background: linear-gradient(135deg, #22d3ee, #a78bfa); color: #020617; }
        button:disabled { cursor: not-allowed; opacity: 0.5; }
        label { display: grid; gap: 8px; margin-top: 18px; color: #cbd5e1; }
        input { background: #020617; color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.35); }
        .meta, time, .hint { color: #94a3b8; font-size: 0.9rem; }
        .hint { margin-bottom: 0; }
        .error { background: #7f1d1d; color: #fee2e2; padding: 16px; border-radius: 16px; }
        .audit { margin-top: 20px; }
        a { color: #67e8f9; display: block; margin-top: 16px; overflow-wrap: anywhere; }
        li { margin: 10px 0; }
      `}</style>
    </main>
  )
}
