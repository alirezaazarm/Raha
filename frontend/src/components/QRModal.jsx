import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { FiChevronLeft, FiChevronRight, FiLoader, FiList } from 'react-icons/fi'
import { getConfigProxies, sendConfigToBot, sendConfigLinksToBot } from '../api/client'

const CloseIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
)

const TelegramIcon = () => (
  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.52-1.4.51-.46-.01-1.35-.26-2.01-.48-.81-.27-1.45-.42-1.39-.89.03-.24.37-.49 1.02-.74 4-1.74 6.67-2.88 8-3.43 3.81-1.58 4.6-1.85 5.12-1.86.11 0 .37.03.54.17.14.12.18.28.2.44-.01.07 0 .14-.01.21z" />
  </svg>
)

export default function QRModal({ email, configName, subscriptionLink, onClose }) {
  const { t } = useTranslation('common')
  const [zipPassword, setZipPassword] = useState('')
  const [showZipInput, setShowZipInput] = useState(false)
  const [sendingZip, setSendingZip] = useState(false)
  const [sendingList, setSendingList] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [proxies, setProxies] = useState([])
  const [loadingProxies, setLoadingProxies] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const touchStartX = useRef(null)
  const tabsRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoadingProxies(true)
    getConfigProxies(email)
      .then((data) => {
        if (!cancelled) setProxies(Array.isArray(data) ? data : [])
      })
      .catch(() => {
        if (!cancelled) setProxies([])
      })
      .finally(() => {
        if (!cancelled) setLoadingProxies(false)
      })
    return () => { cancelled = true }
  }, [email])

  const slides = useMemo(() => {
    const list = []
    if (subscriptionLink) {
      list.push({ name: t('qrModal.subscription'), link: subscriptionLink, isSubscription: true })
    }
    proxies.forEach((p, idx) => {
      list.push({
        name: p.name || t('qrModal.proxy', { index: idx + 1 }),
        link: p.link,
        isSubscription: false,
      })
    })
    return list
  }, [proxies, subscriptionLink, t])

  useEffect(() => {
    if (activeIndex > slides.length - 1) setActiveIndex(0)
  }, [slides.length, activeIndex])

  useEffect(() => {
    const el = tabsRef.current?.querySelector(`[data-tab="${activeIndex}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeIndex])

  const current = slides[activeIndex]
  const canNavigate = slides.length > 1
  const go = (delta) => {
    if (!canNavigate) return
    setActiveIndex((idx) => (idx + delta + slides.length) % slides.length)
  }

  const onTouchStart = (e) => { touchStartX.current = e.touches[0]?.clientX ?? null }
  const onTouchEnd = (e) => {
    if (touchStartX.current == null) return
    const delta = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current
    touchStartX.current = null
    if (Math.abs(delta) < 40) return
    go(delta < 0 ? 1 : -1)
  }

  const handleSendZip = async () => {
    if (!zipPassword.trim()) return
    setSendingZip(true)
    setFeedback(null)
    try {
      const res = await sendConfigToBot(email, zipPassword.trim())
      setFeedback({ type: 'success', text: res.message || t('qrModal.sent') })
      setShowZipInput(false)
      setZipPassword('')
    } catch (err) {
      setFeedback({ type: 'error', text: err?.response?.data?.detail || t('qrModal.failed') })
    } finally {
      setSendingZip(false)
    }
  }

  const handleSendList = async () => {
    setSendingList(true)
    setFeedback(null)
    try {
      const res = await sendConfigLinksToBot(email)
      setFeedback({ type: 'success', text: res.message || t('qrModal.listSent') })
    } catch (err) {
      setFeedback({ type: 'error', text: err?.response?.data?.detail || t('qrModal.listFailed') })
    } finally {
      setSendingList(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[150] flex items-end justify-center bg-black/70 backdrop-blur-sm px-4 pb-24"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-slate-800 rounded-2xl ring-1 ring-slate-700 w-full max-w-sm p-5 space-y-4 overflow-y-auto max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold text-base truncate pe-2">{configName || t('qrModal.vpnConfig')}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-700 transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Carousel tabs */}
        <div
          ref={tabsRef}
          className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {slides.map((slide, idx) => (
            <button
              key={`${slide.link}-${idx}`}
              data-tab={idx}
              type="button"
              onClick={() => setActiveIndex(idx)}
              className={`shrink-0 max-w-[150px] truncate text-[11px] font-semibold px-2.5 py-1.5 rounded-pill border transition-colors ${
                idx === activeIndex
                  ? 'bg-emerald-500 text-white border-emerald-500'
                  : 'bg-slate-700/60 text-slate-300 border-slate-600 hover:bg-slate-700'
              }`}
              title={slide.name}
            >
              {slide.name}
            </button>
          ))}
          {loadingProxies && slides.length <= 1 && (
            <span className="shrink-0 text-[11px] text-slate-400 px-2 py-1.5 flex items-center gap-1">
              <FiLoader className="animate-spin" size={12} />
              {t('qrModal.loadingProxies')}
            </span>
          )}
        </div>

        {/* QR area */}
        <div className="relative">
          <div
            className="flex items-center justify-center bg-white rounded-xl p-4 min-h-[200px] touch-pan-y"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            {current?.link ? (
              <QRCodeSVG value={current.link} size={180} level="M" includeMargin={false} />
            ) : (
              <div className="text-slate-500 text-sm text-center px-4">
                {loadingProxies ? t('qrModal.loadingProxies') : t('qrModal.noLink')}
              </div>
            )}
          </div>

          {canNavigate && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                className="absolute start-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-slate-900/70 text-white hover:bg-slate-900"
                aria-label={t('qrModal.previous')}
              >
                <FiChevronLeft size={16} />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                className="absolute end-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-slate-900/70 text-white hover:bg-slate-900"
                aria-label={t('qrModal.next')}
              >
                <FiChevronRight size={16} />
              </button>
            </>
          )}
        </div>

        {/* Current slide label + dots */}
        {slides.length > 0 && (
          <div className="text-center -mt-1">
            <p className="text-white text-[13px] font-semibold truncate px-3">{current?.name}</p>
            <div className="flex items-center justify-center gap-1 mt-1.5">
              {slides.length <= 12 ? (
                slides.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveIndex(idx)}
                    className={`h-1.5 rounded-full transition-all ${
                      idx === activeIndex ? 'w-4 bg-emerald-400' : 'w-1.5 bg-slate-600'
                    }`}
                    aria-label={t('qrModal.goToSlide', { index: idx + 1 })}
                  />
                ))
              ) : (
                <span className="text-[11px] text-slate-400">
                  {t('qrModal.slideCount', { current: activeIndex + 1, total: slides.length })}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Subscription link preview */}
        {current?.isSubscription && current.link && (
          <div className="bg-slate-900 rounded-lg px-3 py-2 border border-slate-700">
            <p className="text-slate-400 text-xs break-all line-clamp-3 font-mono">{current.link}</p>
          </div>
        )}

        {/* Send to Telegram section */}
        {!showZipInput ? (
          <button
            onClick={() => setShowZipInput(true)}
            className="w-full flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-medium text-sm py-3 rounded-xl transition-colors"
          >
            <TelegramIcon />
            {t('qrModal.sendToTelegram')}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="password"
                value={zipPassword}
                onChange={(e) => setZipPassword(e.target.value)}
                placeholder={t('qrModal.setPassword')}
                className="flex-1 bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500"
                onKeyDown={(e) => e.key === 'Enter' && handleSendZip()}
                autoFocus
              />
              <button
                onClick={handleSendZip}
                disabled={sendingZip || !zipPassword.trim()}
                className="flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium px-4 rounded-xl transition-colors"
              >
                {sendingZip ? (
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  t('qrModal.send')
                )}
              </button>
              <button
                onClick={() => { setShowZipInput(false); setZipPassword(''); setFeedback(null) }}
                className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-700 transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Send plain list of all config links */}
        <button
          onClick={handleSendList}
          disabled={sendingList || loadingProxies}
          className="w-full flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium text-sm py-3 rounded-xl transition-colors"
        >
          {sendingList ? <FiLoader className="animate-spin" size={16} /> : <FiList size={16} />}
          {t('qrModal.sendListToTelegram')}
        </button>

        {feedback && (
          <p className={`text-center text-xs py-2 rounded-lg ${
            feedback.type === 'success'
              ? 'text-emerald-400 bg-emerald-400/10'
              : 'text-rose-400 bg-rose-400/10'
          }`}>
            {feedback.text}
          </p>
        )}
      </div>
    </div>
  )
}
