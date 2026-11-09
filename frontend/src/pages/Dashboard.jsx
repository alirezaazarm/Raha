import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import ConfigCard from '../components/ConfigCard'
import UsageHistogram from '../components/UsageHistogram'
import { createConfig } from '../api/client'
import { toAsciiDigits } from '../components/NumberFields'
import {
  FiPlus, FiX, FiAlertCircle, FiActivity, FiServer, FiClock, FiPieChart,
  FiSmartphone, FiCheck, FiLoader,
} from 'react-icons/fi'

function bytesToGB(bytes) {
  if (!bytes || bytes === 0) return 0
  return bytes / (1024 * 1024 * 1024)
}

function daysLeft(dateStr) {
  if (!dateStr) return null
  const expiry = new Date(dateStr)
  const now = new Date()
  return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
}

// Accept Persian/Arabic/any Unicode digits and normalise to ASCII so the
// user can keep their own keyboard layout while typing numbers.
function sanitizeDecimalText(raw) {
  const ascii = toAsciiDigits(String(raw ?? '')).replace(/[^\d.]/g, '')
  const parts = ascii.split('.')
  const intPart = parts[0].replace(/^0+(?=\d)/, '')
  if (parts.length > 1) {
    return (intPart || '0') + '.' + parts.slice(1).join('').slice(0, 2)
  }
  return intPart
}

function sanitizeIntText(raw) {
  return toAsciiDigits(String(raw ?? ''))
    .replace(/\D/g, '')
    .replace(/^0+(?=\d)/, '')
}

function estimateDaysRemaining(configs) {
  const active = configs.filter(c => c.status === 'active')
  if (active.length === 0) return null
  let totalDays = 0; let count = 0
  for (const c of active) {
    const d = daysLeft(c.expiry_date)
    if (d !== null && d > 0) {
      const used = bytesToGB((c.usage_up || 0) + (c.usage_down || 0))
      const remaining = c.total_gb - used
      if (used <= 0 || remaining <= 0) {
        totalDays += d
      } else {
        const estimatedAgeDays = (used * d) / remaining
        const dailyAvg = used / Math.max(estimatedAgeDays, 1)
        const est = remaining / dailyAvg
        totalDays += Math.min(Math.max(est, 0), d)
      }
      count++
    }
  }
  return count > 0 ? Math.round(totalDays / count) : null
}

function SkeletonHero() {
  return (
    <div className="bg-dark-card rounded-card p-5 space-y-4 animate-fade-in">
      <div className="skeleton h-3 w-20" />
      <div className="skeleton h-9 w-40" />
      <div className="flex gap-3">
        {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-10 flex-1" />)}
      </div>
    </div>
  )
}

function SkeletonConfigs() {
  return (
    <div className="space-y-2.5">
      {[1, 2].map(i => (
        <div key={i} className="bg-dark-card rounded-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="skeleton h-2 w-2 rounded-full" />
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-4 w-14 rounded-pill" />
          </div>
          <div className="skeleton h-1.5 w-full rounded-pill" />
          <div className="flex justify-between">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-3 w-8" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const { t } = useTranslation('dashboard')
  const { user, configs, loading, configsError, setConfigsError, refreshConfigs, refreshUser } = useApp()
  const navigate = useNavigate()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', total_gb: '1', duration_days: '30', limit_ip: '' })
  const [nameWarning, setNameWarning] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

  const totalUsedGB = configs.reduce((sum, c) => sum + bytesToGB((c.usage_up || 0) + (c.usage_down || 0)), 0)
  const totalGB = configs.reduce((sum, c) => sum + (c.total_gb || 0), 0)
  const usagePct = totalGB > 0 ? Math.min(100, Math.round((totalUsedGB / totalGB) * 100)) : 0
  const trafficBalanceGB = user?.traffic_balance_gb ?? 0
  const activeConfigs = configs.filter(c => c.status === 'active').length
  const estDays = estimateDaysRemaining(configs)

  const handleCharge = () => navigate('/profile')

  const openCreateModal = () => {
    setCreateError(null)
    setNameWarning(false)
    setShowCreateModal(true)
  }

  const closeCreateModal = () => {
    setShowCreateModal(false)
    setCreateError(null)
    setNameWarning(false)
  }

  const handleCreateConfig = async (e) => {
    e.preventDefault()
    setCreateError(null)
    const name = createForm.name.trim()
    const totalGb = parseFloat(createForm.total_gb) || 0
    const durationDays = parseInt(createForm.duration_days || '0', 10) || 0
    const limitIp = createForm.limit_ip === '' ? 0 : parseInt(createForm.limit_ip, 10) || 0

    if (!name) { setCreateError(t('createModal.nameRequired')); return }
    if (/[-/\\\s]/.test(name)) { setCreateError(t('createModal.nameInvalid')); return }
    if (!(totalGb > 0)) { setCreateError(t('createModal.trafficPositive')); return }
    if (totalGb > trafficBalanceGB) {
      setCreateError(t('createModal.insufficientTraffic', { trafficBalance: trafficBalanceGB.toFixed(2) }))
      return
    }
    if (durationDays < 0) { setCreateError(t('createModal.durationNonNegative')); return }
    if (limitIp < 0 || limitIp > 5) { setCreateError(t('createModal.deviceLimitInvalid')); return }
    setCreating(true)
    try {
      await createConfig({ name, total_gb: totalGb, duration_days: durationDays, limit_ip: limitIp })
      setShowCreateModal(false)
      setCreateForm({ name: '', total_gb: '1', duration_days: '30', limit_ip: '' })
      await Promise.all([refreshConfigs(), refreshUser()])
    } catch (err) {
      const detail = err.response?.data?.detail || err.message || t('createModal.failedCreate')
      setCreateError(detail)
    } finally {
      setCreating(false)
    }
  }

  const handleConfigUpdate = async () => {
    await Promise.all([refreshConfigs(), refreshUser()])
  }

  const createTotalGb = parseFloat(createForm.total_gb) || 0
  const createDurationDays = createForm.duration_days === '' ? 0 : (parseInt(createForm.duration_days, 10) || 0)
  const createLimitIp = createForm.limit_ip === '' ? 0 : (parseInt(createForm.limit_ip, 10) || 0)
  const deviceLimitOptions = [0, 1, 2, 3, 4, 5]

  const sortedConfigs = [...configs].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1
    if (a.status !== 'active' && b.status === 'active') return 1
    return 0
  })

  return (
    <div className="px-3 py-3 space-y-3">

      {loading && configs.length === 0 ? (
        <>
          <SkeletonHero />
          <div className="skeleton h-36 w-full rounded-card" />
          <SkeletonConfigs />
        </>
      ) : (
        <>
          {/* Hero Card */}
          <div className="bg-dark-card rounded-card p-5 relative overflow-hidden">
            <div className="absolute top-0 end-0 w-32 h-32 bg-emerald-500/5 rounded-full -translate-y-1/2 translate-x-1/2" />
            <div className="relative z-10">
              <p className="text-gray-500 text-[13px] font-medium mb-1">{t('hero.availableTraffic')}</p>
              <div className="flex items-end justify-between mb-4">
                <p className="text-[32px] font-bold text-white leading-none tracking-tight">
                  {trafficBalanceGB.toFixed(2)}
                  <span className="text-base font-medium text-gray-400 ms-1">GB</span>
                </p>
                <button
                  onClick={openCreateModal}
                  className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-white text-[13px] font-semibold px-4 py-2.5 rounded-btn transition-all active:scale-[0.98] shadow-glow"
                >
                  <FiPlus size={15} />
                  {t('hero.newConfig')}
                </button>
              </div>
              {trafficBalanceGB <= 0 && (
                <button
                  onClick={() => navigate('/profile')}
                  className="text-[11px] font-semibold text-amber-400 mb-3 flex items-center gap-1"
                >
                  <FiAlertCircle size={12} />
                  {t('hero.buyTraffic')}
                </button>
              )}
              <div className="flex items-center gap-3 pt-3 border-t border-white/5">
                <div className="flex items-center gap-1.5">
                  <FiActivity size={12} className="text-gray-500" />
                  <span className="text-[13px] font-semibold text-white">{totalUsedGB.toFixed(1)}</span>
                  <span className="text-[11px] text-gray-500">{t('hero.used')}</span>
                </div>
                <div className="w-px h-4 bg-white/10" />
                <div className="flex items-center gap-1.5">
                  <FiServer size={12} className="text-gray-500" />
                  <span className="text-[13px] font-semibold text-white">{activeConfigs}</span>
                  <span className="text-[11px] text-gray-500">{t('hero.active')}</span>
                </div>
                <div className="w-px h-4 bg-white/10" />
                <div className="flex items-center gap-1.5">
                  <FiClock size={12} className="text-gray-500" />
                  <span className="text-[13px] font-semibold text-white">
                    {estDays !== null ? `~${estDays}` : '—'}
                  </span>
                  <span className="text-[11px] text-gray-500">{t('hero.days')}</span>
                </div>
                <div className="w-px h-4 bg-white/10" />
                <div className="flex items-center gap-1.5">
                  <FiPieChart size={12} className="text-gray-500" />
                  <span className="text-[13px] font-semibold text-white">{usagePct}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Configs Error Banner */}
          {configsError && (
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-card p-3 flex items-center justify-between animate-fade-in">
              <div className="flex items-center gap-2">
                <FiAlertCircle size={14} className="text-rose-400 shrink-0" />
                <p className="text-rose-400 text-[12px]">{configsError}</p>
              </div>
              <button
                onClick={() => { setConfigsError(null); refreshConfigs(); refreshUser(); }}
                className="text-rose-400 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 transition-colors"
              >
                {t('hero.retry', { ns: 'common' })}
              </button>
            </div>
          )}

          {/* Usage Overview */}
          {configs.length > 0 && (
            <UsageHistogram configs={configs} />
          )}

          {/* Configs Section */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-white text-[18px] font-bold">{t('configs.title')}</h2>
              {configs.length > 0 && (
                <span className="text-[12px] text-gray-500 font-medium">{t('configs.total', { count: configs.length })}</span>
              )}
            </div>

            {configs.length === 0 ? (
              <div className="bg-dark-card rounded-card p-8 text-center">
                <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                  <FiServer size={24} className="text-emerald-400" />
                </div>
                <p className="text-white font-semibold text-[16px] mb-1">{t('configs.noConfigs')}</p>
                <p className="text-gray-500 text-[13px] mb-4">{t('configs.noConfigsDesc')}</p>
                {trafficBalanceGB > 0 ? (
                  <button
                    onClick={openCreateModal}
                    className="bg-emerald-500 hover:bg-emerald-400 text-white text-[13px] font-semibold px-5 py-2.5 rounded-btn transition-all active:scale-[0.98]"
                  >
                    {t('configs.createFirst')}
                  </button>
                ) : (
                  <button
                    onClick={() => navigate('/profile')}
                    className="bg-emerald-500 hover:bg-emerald-400 text-white text-[13px] font-semibold px-5 py-2.5 rounded-btn transition-all active:scale-[0.98]"
                  >
                    {t('configs.getPlan')}
                  </button>
                )}
              </div>
            ) : (
              sortedConfigs.map((config) => (
                <ConfigCard
                  key={config.uuid || config.email}
                  config={config}
                  onCharge={handleCharge}
                  onRefresh={handleConfigUpdate}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* Create Config Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4" onClick={e => { if (e.target === e.currentTarget) closeCreateModal() }}>
          <div className="w-full max-w-sm bg-dark-card border border-white/10 rounded-t-3xl sm:rounded-2xl animate-scale-in shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/5 shrink-0">
              <div>
                <h3 className="text-white text-[15px] font-bold leading-tight">{t('createModal.title')}</h3>
                <p className="text-gray-500 text-[10px] mt-0.5">{t('createModal.subtitle')}</p>
              </div>
              <button onClick={closeCreateModal} className="p-1.5 hover:bg-white/5 rounded-lg text-gray-400 transition-colors">
                <FiX size={16} />
              </button>
            </div>

            <div className="px-4 py-3 overflow-y-auto">
              {createError && (
                <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg px-2.5 py-2 text-rose-400 text-[11px] mb-3 flex items-start gap-1.5">
                  <FiAlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>{createError}</span>
                </div>
              )}
              <form onSubmit={handleCreateConfig} className="space-y-3">
                {/* Name */}
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400">{t('createModal.name')}</label>
                  <input
                    type="text"
                    value={createForm.name}
                    onChange={e => {
                      const raw = e.target.value
                      setNameWarning(/[-/\\\s]/.test(raw))
                      setCreateForm(f => ({ ...f, name: raw.replace(/[-/\\\s]/g, '').slice(0, 32) }))
                    }}
                    placeholder={t('createModal.namePlaceholder')}
                    maxLength={32}
                    required
                    autoComplete="off"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-[14px] focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                  <p className={`text-[10px] ${nameWarning ? 'text-amber-400' : 'text-gray-600'}`}>
                    {nameWarning ? t('createModal.nameInvalid') : t('createModal.nameHint')}
                  </p>
                </div>

                {/* Traffic + Duration */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <label className="text-[11px] font-semibold text-gray-400">{t('createModal.traffic')}</label>
                      <span className="text-[9px] text-gray-600 truncate">{trafficBalanceGB.toFixed(1)} GB</span>
                    </div>
                    <div className="flex items-center bg-white/5 border border-white/10 rounded-lg px-2.5 focus-within:border-emerald-500 transition-colors">
                      <input
                        type="text"
                        inputMode="decimal"
                        dir="ltr"
                        value={createForm.total_gb}
                        onChange={e => setCreateForm(f => ({ ...f, total_gb: sanitizeDecimalText(e.target.value) }))}
                        placeholder="0"
                        className="w-full min-w-0 bg-transparent py-2 text-[17px] font-bold text-white outline-none tabular-nums"
                      />
                      <span className="text-[10px] font-semibold text-gray-500 shrink-0">GB</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {[1, 5, 10, 25, 50].filter(p => p <= trafficBalanceGB).slice(0, 3).map(p => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setCreateForm(f => ({ ...f, total_gb: String(p) }))}
                          className={`px-2 py-0.5 rounded-pill text-[10px] font-semibold border transition-all active:scale-[0.97] ${
                            createTotalGb === p
                              ? 'bg-emerald-500 text-white border-emerald-500'
                              : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1 min-w-0">
                    <label className="block text-[11px] font-semibold text-gray-400">{t('createModal.duration')}</label>
                    <div className="flex items-center bg-white/5 border border-white/10 rounded-lg px-2.5 focus-within:border-emerald-500 transition-colors">
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        value={createForm.duration_days}
                        onChange={e => setCreateForm(f => ({ ...f, duration_days: sanitizeIntText(e.target.value) }))}
                        placeholder="∞"
                        className="w-full min-w-0 bg-transparent py-2 text-[17px] font-bold text-white outline-none tabular-nums"
                      />
                      <span className="text-[10px] font-semibold text-gray-500 shrink-0">
                        {createForm.duration_days === '' ? '∞' : t('createModal.daysShort')}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {['1', '30', '60', '90'].map(d => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setCreateForm(f => ({ ...f, duration_days: d }))}
                          className={`px-2 py-0.5 rounded-pill text-[10px] font-semibold border transition-all active:scale-[0.97] ${
                            createForm.duration_days === d
                              ? 'bg-emerald-500 text-white border-emerald-500'
                              : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setCreateForm(f => ({ ...f, duration_days: '' }))}
                        className={`px-2 py-0.5 rounded-pill text-[10px] font-semibold border transition-all active:scale-[0.97] ${
                          createDurationDays === 0
                            ? 'bg-emerald-500 text-white border-emerald-500'
                            : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
                        }`}
                        title={t('createModal.unlimited')}
                      >
                        ∞
                      </button>
                    </div>
                  </div>
                </div>

                {/* Concurrent device limit */}
                <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 min-w-0">
                      <FiSmartphone size={11} className="text-emerald-400 shrink-0" />
                      <span className="truncate">{t('createModal.deviceLimit')}</span>
                    </span>
                    <span className="text-[9px] text-gray-600 shrink-0">
                      {createLimitIp === 0 ? t('createModal.unlimited') : `${createLimitIp} ${t('createModal.devicesShort')}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-6 gap-1">
                    {deviceLimitOptions.map(option => {
                      const selected = createLimitIp === option
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setCreateForm(f => ({ ...f, limit_ip: option === 0 ? '' : String(option) }))}
                          className={`py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-[0.97] ${
                            selected
                              ? 'bg-emerald-500 text-white border-emerald-500'
                              : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
                          }`}
                        >
                          {option === 0 ? '∞' : option}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[9px] text-gray-600 leading-snug">{t('createModal.deviceLimitHint')}</p>
                </div>

                <button
                  type="submit"
                  disabled={creating}
                  className="w-full flex items-center justify-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg transition-all active:scale-[0.98] text-[13px]"
                >
                  {creating ? <FiLoader className="animate-spin" size={14} /> : <FiCheck size={14} />}
                  {creating ? t('createModal.creating') : t('createModal.create')}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
