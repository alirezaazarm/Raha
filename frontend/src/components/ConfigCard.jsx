import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  FiCopy, FiTrash2, FiPower, FiLoader, FiClock, FiZap, FiMinus, FiSmartphone
} from 'react-icons/fi'
import { MdQrCode } from 'react-icons/md'
import { toggleConfig, deleteConfig, editConfig, getSubscriptionLink } from '../api/client'
import { useApp } from '../context/AppContext'
import { TrafficField, DurationField } from './NumberFields'
import QRModal from './QRModal'
import { formatDateShort } from '../utils/dates'

function daysLeft(dateStr) {
  if (!dateStr) return null
  const expiry = new Date(dateStr)
  const now = new Date()
  return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
}

async function copyToClipboard(text) {
  if (!text) return false
  // Must stay inside the original click gesture, otherwise mobile WebViews
  // (Telegram included) silently drop the clipboard write.
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function ConfigCard({ config, onUpdate, onCharge, onRefresh }) {
  const { t } = useTranslation('common')
  const { setConfigs, refreshConfigs, user, refreshUser } = useApp()
  const navigate = useNavigate()
  const [showQR, setShowQR] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [showRecharge, setShowRecharge] = useState(false)
  const [rechargeValue, setRechargeValue] = useState(0)
  const [rechargeError, setRechargeError] = useState(null)
  const [durationValue, setDurationValue] = useState(0)

  const trafficBalanceGB = user?.traffic_balance_gb ?? 0

  const usedGb = (config.usage_up + config.usage_down) / (1024 ** 3)
  const usagePercent = config.total_gb > 0 ? Math.min(100, (usedGb / config.total_gb) * 100) : 0
  const isEnabled = config.enable
  const expiryDays = daysLeft(config.expiry_date)
  const isDepleted = config.total_gb > 0 && usedGb >= config.total_gb
  const isExpired = config.status === 'expired' || (expiryDays !== null && expiryDays <= 0) || isDepleted
  const limitIp = Number(config.limit_ip || 0)
  // disabled → grey, expired/exhausted → red, healthy + enabled → green.
  const visualState = !isEnabled ? 'disabled' : isExpired ? 'expired' : 'active'
  const stateStyles = {
    active: {
      card: 'border-emerald-500/40 ring-1 ring-emerald-500/40',
      overlay: 'bg-gradient-to-br from-emerald-500/[0.10] via-transparent to-emerald-500/[0.04]',
      dot: 'bg-emerald-400',
    },
    expired: {
      card: 'border-red-500/40 ring-1 ring-red-500/40',
      overlay: 'bg-gradient-to-br from-red-500/[0.10] via-transparent to-red-500/[0.04]',
      dot: 'bg-red-400',
    },
    disabled: {
      card: 'border-gray-500/30 ring-1 ring-gray-500/30',
      overlay: 'bg-gradient-to-br from-gray-500/[0.10] via-transparent to-gray-500/[0.04]',
      dot: 'bg-gray-500',
    },
  }[visualState]

  const currentDurationDays = useMemo(() => {
    if (!config.expiry_date) return 0
    const d = daysLeft(config.expiry_date)
    if (d === null) return 0
    return Math.max(0, d)
  }, [config.expiry_date])

  const refreshAfterAction = async () => {
    if (onRefresh) await onRefresh()
    else if (onUpdate) onUpdate()
  }

  const handleToggle = async () => {
    if (busy) return
    setBusy(true)
    const prevEnable = config.enable
    const targetUuid = config.uuid
    if (!targetUuid) console.warn('handleToggle: targetUuid is missing', config)
    setConfigs(prev => prev.map(c =>
      c.uuid === targetUuid ? { ...c, enable: !prevEnable } : c
    ))
    try {
      await toggleConfig(config.email)
      await refreshConfigs()
    } catch (err) {
      setConfigs(prev => prev.map(c =>
        c.uuid === targetUuid ? { ...c, enable: prevEnable } : c
      ))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm(t('confirmDialogs.deleteConfig'))) return
    setBusy(true)
    const targetUuid = config.uuid
    const deletedConfig = config
    setConfigs(prev => prev.filter(c => c.uuid !== targetUuid))
    try {
      await deleteConfig(config.email)
      await refreshAfterAction()
    } catch (err) {
      setConfigs(prev => [...prev, deletedConfig])
    } finally {
      setBusy(false)
    }
  }

  const handleCopyLink = async () => {
    if (copyBusy) return
    const cachedLink = config.subscription_link || ''

    // Fast path: the link is already in the config payload, so copy it
    // synchronously inside the tap gesture instead of waiting for a network
    // round-trip. This is what made the old copy button feel laggy/unreliable.
    if (cachedLink) {
      const ok = await copyToClipboard(cachedLink)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
      return
    }

    setCopyBusy(true)
    try {
      const data = await getSubscriptionLink(config.email)
      const link = data?.subscription_link || ''
      if (!link) return
      setConfigs(prev => prev.map(c =>
        c.uuid === config.uuid ? { ...c, subscription_link: link } : c
      ))
      const ok = await copyToClipboard(link)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setCopyBusy(false)
    }
  }

  const rechargeMin = useMemo(() => {
    const m = Math.max(0, usedGb)
    return Math.min(m, config.total_gb + trafficBalanceGB)
  }, [usedGb, config.total_gb, trafficBalanceGB])
  const rechargeMax = useMemo(() => Math.max(rechargeMin, config.total_gb + trafficBalanceGB), [rechargeMin, config.total_gb, trafficBalanceGB])

  const handleRecharge = () => {
    if (trafficBalanceGB > 0 || config.total_gb > usedGb) {
      setRechargeValue(Math.max(rechargeMin, Math.min(config.total_gb, rechargeMax)))
      setDurationValue(currentDurationDays)
      setRechargeError(null)
      setShowRecharge(true)
    } else {
      navigate('/profile')
    }
  }

  const confirmRecharge = async () => {
    if (rechargeValue < rechargeMin || rechargeValue > rechargeMax) return
    if (durationValue < 0) return
    setBusy(true)
    setRechargeError(null)
    try {
      const payload = {
        total_gb: rechargeValue,
        duration_days: durationValue,
      }
      await editConfig(config.email, payload)
      setShowRecharge(false)
      await refreshAfterAction()
      await refreshUser()
    } catch (err) {
      setRechargeError(err?.response?.data?.detail || 'Failed to update config')
    } finally {
      setBusy(false)
    }
  }

  const progressColor = usagePercent > 85 ? 'bg-red-500'
    : usagePercent > 60 ? 'bg-amber-500'
    : isEnabled ? 'bg-emerald-500' : 'bg-gray-500'

  const statusColor = config.status === 'active' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    : config.status === 'expired' ? 'text-red-400 bg-red-500/10 border-red-500/20'
    : 'text-gray-400 bg-gray-500/10 border-gray-500/20'

  return (
    <>
      <div className={`relative overflow-hidden bg-dark-card rounded-card p-4 animate-fade-in border ${stateStyles.card}`}>
        <div className={`pointer-events-none absolute inset-0 ${stateStyles.overlay}`} />
        <div className="relative z-10">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${stateStyles.dot}`} />
            <span className="text-white font-semibold text-[14px] truncate">{config.name || t('config.unnamed')}</span>
          </div>
          <span className={`px-2 py-0.5 rounded-pill text-[10px] font-bold uppercase tracking-wider border ${statusColor} shrink-0`}>
            {config.status}
          </span>
        </div>

        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[13px] font-semibold text-white">
            {usedGb.toFixed(1)} <span className="text-gray-500 font-normal">/ {config.total_gb.toFixed(1)} GB</span>
          </span>
          <span className="text-[11px] font-bold text-gray-400">{Math.round(usagePercent)}%</span>
        </div>

        <div className="progress-bar mb-2.5">
          <div className={`progress-bar-fill ${progressColor}`} style={{ width: `${usagePercent}%` }} />
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1 text-[11px] text-gray-500">
            <FiClock size={10} />
            {config.expiry_date ? (
              expiryDays !== null && expiryDays > 0 ? (
                <span className={expiryDays <= 3 ? 'text-amber-400 font-semibold' : ''}>
                  {expiryDays === 1 ? t('config.dayLeft', { days: expiryDays }) : t('config.daysLeft', { days: expiryDays })}
                </span>
              ) : expiryDays !== null && expiryDays <= 0 ? (
                <span className="text-red-400 font-semibold">{t('config.expired')}</span>
              ) : (
                <span>{formatDateShort(config.expiry_date)}</span>
              )
            ) : (
              <span>{t('config.noExpiry')}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-pill border ${
                limitIp > 0
                  ? 'text-sky-300 bg-sky-500/10 border-sky-500/20'
                  : 'text-gray-400 bg-white/5 border-white/10'
              }`}
              title={t('config.deviceLimit')}
            >
              <FiSmartphone size={10} />
              {limitIp > 0 ? limitIp : '∞'}
            </span>
            {config.inbound_names && config.inbound_names.length > 0 && (
              <div className="flex gap-1">
                {config.inbound_names.slice(0, 2).map((name, i) => (
                  <span key={i} className="text-[10px] text-gray-500 bg-white/5 px-1.5 py-0.5 rounded-pill">
                    {name.length > 8 ? name.slice(0, 8) + '..' : name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowQR(true)}
            className="flex items-center justify-center bg-emerald-500 hover:bg-emerald-400 text-white p-2.5 rounded-icon-btn transition-all active:scale-[0.98] flex-1"
            title={t('config.showQR')}
          >
            <MdQrCode size={16} />
          </button>
          <button
            onClick={handleCopyLink}
            disabled={copyBusy}
            className={`flex items-center justify-center p-2.5 rounded-icon-btn transition-all active:scale-[0.98] flex-1 disabled:opacity-50 ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-white/10 hover:bg-white/15 text-gray-300'
            }`}
            title={t('config.copyLink')}
          >
            {copyBusy ? <FiLoader className="animate-spin" size={14} /> : <FiCopy size={14} />}
          </button>
          <button
            onClick={handleRecharge}
            className="flex items-center justify-center bg-white/10 hover:bg-white/15 text-gray-300 p-2.5 rounded-icon-btn transition-all active:scale-[0.98] flex-1"
            title={t('config.editTrafficDuration')}
          >
            <FiZap size={14} />
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="flex items-center justify-center bg-white/10 hover:bg-rose-500/20 text-gray-400 hover:text-rose-400 p-2.5 rounded-icon-btn transition-all active:scale-[0.98] flex-1 disabled:opacity-30"
            title={t('actions.delete')}
          >
            <FiTrash2 size={14} />
          </button>
          <button
            onClick={handleToggle}
            disabled={busy}
            className={`flex items-center justify-center p-2.5 rounded-icon-btn transition-all active:scale-[0.98] shrink-0 ${
              isEnabled
                ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                : 'bg-white/10 text-gray-500 hover:bg-white/15'
            }`}
            title={isEnabled ? t('config.disable') : t('config.enable')}
          >
            {busy ? <FiLoader className="animate-spin" size={15} /> : <FiPower size={16} />}
          </button>
        </div>
        </div>
      </div>

      {copied && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] bg-emerald-600 text-white text-[12px] font-semibold px-4 py-2 rounded-pill shadow-lg animate-fade-in">
          {t('config.copied')}
        </div>
      )}

      {showRecharge && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={e => { if (e.target === e.currentTarget) setShowRecharge(false) }}>
          <div className="w-full max-w-sm bg-dark-card border border-white/10 rounded-2xl animate-scale-in overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h3 className="text-[15px] font-bold text-white">{t('config.editConfig')}</h3>
              <button onClick={() => setShowRecharge(false)} className="p-1.5 hover:bg-white/5 rounded-lg text-gray-400 transition-colors">
                <FiMinus size={16} />
              </button>
            </div>
            <div className="px-4 pb-4 space-y-3">
              {rechargeError && (
                <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2 text-rose-400 text-[12px]">{rechargeError}</div>
              )}

              <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">{t('config.traffic')}</label>
                  <TrafficField
                    value={rechargeValue}
                    onChange={setRechargeValue}
                    min={rechargeMin}
                    max={rechargeMax}
                    unit="GB"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">{t('config.duration')}</label>
                  <DurationField
                    value={durationValue}
                    onChange={setDurationValue}
                    min={0}
                    allowInfinite
                    unit="days"
                  />
                </div>

                <button
                  onClick={confirmRecharge}
                  disabled={busy}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white font-semibold py-2.5 rounded-btn transition-all active:scale-[0.98] text-[13px]"
                >
                  {busy ? t('actions.applying') : t('actions.apply')}
                </button>
            </div>
          </div>
        </div>
      )}

      {showQR && (
        <QRModal
          uuid={config.uuid}
          email={config.email}
          configName={config.name || config.email}
          subscriptionLink={config.subscription_link || ''}
          onClose={() => setShowQR(false)}
        />
      )}
    </>
  )
}
