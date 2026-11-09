import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../context/AppContext';
import client, { verifyAdminPassword, setAdminPasswordHeader, setAdminPasswordForUser, getAdminServerUsage, getAdminUserUsageHistory, getAvailableInbounds, getDefaultInboundIds, saveDefaultInboundIds, postAnnouncement, adminGetLinks, adminAddLinkSection, adminUpdateLinkSection, adminDeleteLinkSection } from '../api/client';
import UsageHistogram from '../components/UsageHistogram';
import { formatDateTime, formatDateShort } from '../utils/dates';
import {
  FiServer, FiUsers, FiTag, FiBarChart2, FiPlus, FiTrash2,
  FiEdit2, FiRefreshCw, FiCheck, FiX, FiZap,
  FiSend, FiRadio, FiLock, FiEye, FiEyeOff, FiAlertCircle,
  FiLink, FiExternalLink, FiChevronDown, FiMessageSquare,
} from 'react-icons/fi';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

const Toast = ({ toasts }) => (
  <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none">
    {toasts.map(t => (
      <div key={t.id} className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg animate-in slide-in-from-top-2 duration-200 ${
        t.type === 'error' ? 'bg-rose-500/90 text-white' : 'bg-emerald-500/90 text-white'
      }`}>
        {t.type === 'error' ? <FiAlertCircle size={15} /> : <FiCheck size={15} />}
        {t.msg}
      </div>
    ))}
  </div>
);

const Card = ({ children, className = "" }) => (
  <div className={`bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-2xl p-4 mb-4 ${className}`}>
    {children}
  </div>
);

const SectionHeader = ({ title, icon: Icon, onAdd }) => (
  <div className="flex items-center justify-between mb-4">
    <div className="flex items-center gap-2">
      <div className="w-1 h-4 bg-emerald-500 rounded-full" />
      <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
        {Icon && <Icon className="text-emerald-500" />}
        {title}
      </h2>
    </div>
    {onAdd && (
      <button onClick={onAdd} className="p-1 hover:bg-slate-700 rounded-lg transition-colors text-emerald-500">
        <FiPlus size={20} />
      </button>
    )}
  </div>
);

const Input = ({ label, ...props }) => (
  <div className="mb-3">
    <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
    <input 
      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
      {...props}
    />
  </div>
);

const Select = ({ label, options, ...props }) => (
  <div className="mb-3">
    <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
    <select 
      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
      {...props}
    >
      {options.map(opt => (
        <option key={opt.value || opt} value={opt.value || opt}>{opt.label || opt}</option>
      ))}
    </select>
  </div>
);

const Button = ({ children, variant = "primary", icon: Icon, ...props }) => {
  const variants = {
    primary: "bg-emerald-500 hover:bg-emerald-600 text-white",
    secondary: "bg-slate-700 hover:bg-slate-600 text-white",
    danger: "bg-rose-500 hover:bg-rose-600 text-white",
    outline: "border border-slate-700 hover:bg-slate-800 text-slate-300"
  };
  return (
    <button 
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 ${variants[variant]}`}
      {...props}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
};

const Badge = ({ children, variant = "info" }) => {
  const variants = {
    success: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    danger: "bg-rose-500/10 text-rose-500 border-rose-500/20",
    info: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    warning: "bg-amber-500/10 text-amber-500 border-amber-500/20"
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${variants[variant]}`}>
      {children}
    </span>
  );
};

// ─── Inbound Usage Histogram (admin, no timezone conversion needed) ────────────

const INBOUND_TIMEFRAMES = [
  { id: 'H', label: 'Hourly' },
  { id: 'D', label: 'Daily' },
];
const INBOUND_WINDOWS = [
  { id: '1D', label: '1D' },
  { id: '1W', label: '1W' },
  { id: '1M', label: '1M' },
  { id: 'all', label: 'All' },
];

function inboundFormatGB(value) {
  if (value === 0) return '0 GB';
  if (value < 0.001) return `${(value * 1024 * 1024).toFixed(0)} KB`;
  if (value < 1) return `${(value * 1024).toFixed(1)} MB`;
  return `${value.toFixed(2)} GB`;
}

function inboundFormatYTick(v) {
  if (v === 0) return '0';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}T`;
  if (v >= 1) return `${v.toFixed(1)}`;
  if (v < 0.01) return `${v.toFixed(3)}`;
  if (v < 0.1) return `${v.toFixed(2)}`;
  return `${v.toFixed(1)}`;
}

function inboundFormatXTick(ts, timeframe) {
  if (!ts) return '';
  // ts is ISO UTC string; display as-is UTC date/time
  const d = new Date(ts.endsWith('Z') || ts.includes('+') ? ts : ts + 'Z');
  if (timeframe === 'H') {
    const h = d.getUTCHours();
    if (h % 6 !== 0) return '';
    return h === 0 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${h}:00`;
  }
  // Daily
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

const InboundTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = new Date(label && (label.endsWith('Z') || label.includes('+')) ? label : (label || '') + 'Z');
  const dateStr = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-slate-400 mb-1">{dateStr}</p>
      <p className="text-blue-400 font-bold">{inboundFormatGB(payload[0].value)}</p>
    </div>
  );
};

function ServerUsageChart({ servers = [] }) {
  const { t } = useTranslation('admin')
  const [timeframe, setTimeframe] = useState('H');
  const [window, setWindow] = useState('1D');
  const [selectedServer, setSelectedServer] = useState('');
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const points = await getAdminServerUsage(timeframe, window, selectedServer);
      setData(points);
    } catch {
      setError(t('serverUsage.failedLoad'));
    } finally {
      setLoading(false);
    }
  }, [timeframe, window, selectedServer]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalGB = data.reduce((s, p) => s + p.gb, 0);
  const maxGB = data.reduce((m, p) => Math.max(m, p.gb), 0);

  const barColor = (value) => {
    if (maxGB === 0) return '#3b82f6';
    const ratio = value / maxGB;
    if (ratio > 0.8) return '#ef4444';
    if (ratio > 0.5) return '#f59e0b';
    return '#3b82f6';
  };

  return (
    <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 p-4 space-y-3 mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-slate-300 font-semibold text-sm flex items-center gap-2">
          <FiBarChart2 className="text-blue-400" size={14} />
          {t('serverUsage.title')}
        </h3>
        <div className="flex items-center gap-2">
          {selectedServer && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">
              {selectedServer}
            </span>
          )}
        </div>
      </div>

      {/* Server selector + Controls */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex rounded-lg overflow-hidden border border-slate-700">
          {INBOUND_TIMEFRAMES.map(tf => (
            <button
              key={tf.id}
              onClick={() => setTimeframe(tf.id)}
              className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
                timeframe === tf.id ? 'bg-blue-500/20 text-blue-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg overflow-hidden border border-slate-700">
          {INBOUND_WINDOWS.map(w => (
            <button
              key={w.id}
              onClick={() => setWindow(w.id)}
              className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
                window === w.id ? 'bg-blue-500/20 text-blue-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-[120px]">
          <select
            value={selectedServer}
            onChange={e => setSelectedServer(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">All Servers</option>
            {servers.map(s => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Chart */}
      <div className="h-36">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="skeleton h-full w-full rounded-lg" />
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">{error}</div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">No data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barCategoryGap="20%">
              <XAxis
                dataKey="ts"
                tickFormatter={ts => inboundFormatXTick(ts, timeframe)}
                tick={{ fill: '#64748b', fontSize: 9 }}
                axisLine={{ stroke: '#334155', strokeWidth: 1 }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={inboundFormatYTick}
                tick={{ fill: '#64748b', fontSize: 9 }}
                axisLine={{ stroke: '#64748b', strokeWidth: 1 }}
                tickLine={false}
                width={36}
                label={{ value: 'GB', position: 'insideTopLeft', offset: 2, fill: '#94a3b8', fontSize: 9, fontWeight: 600 }}
              />
              <Tooltip content={<InboundTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="gb" radius={[2, 2, 0, 0]} maxBarSize={24}>
                {data.map((entry, i) => (
                  <Cell key={i} fill={barColor(entry.gb)} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {data.length > 0 && (
        <div className="flex items-center gap-4 pt-2.5 border-t border-slate-700/50">
          <div>
            <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{t('serverUsage.peak')}</p>
            <p className="text-[13px] font-bold text-white mt-0.5">{inboundFormatGB(maxGB)}</p>
          </div>
          <div className="w-px h-7 bg-slate-700/50" />
          <div>
            <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{t('serverUsage.average')}</p>
            <p className="text-[13px] font-bold text-white mt-0.5">{inboundFormatGB(data.length > 0 ? totalGB / data.length : 0)}</p>
          </div>
          <div className="w-px h-7 bg-slate-700/50" />
          <div>
            <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{t('serverUsage.total')}</p>
            <p className="text-[13px] font-bold text-white mt-0.5">{inboundFormatGB(totalGB)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

export default function Admin() {
  const { t } = useTranslation('admin');
  const { user } = useApp();
  const [activeTab, setActiveTab] = useState("stats");
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [loading, setLoading] = useState(false);
  
  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  // Admin 2FA password gate
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPwdInput, setAdminPwdInput] = useState('');
  const [adminPwdError, setAdminPwdError] = useState(null);
  const [adminPwdLoading, setAdminPwdLoading] = useState(false);
  const [adminPwdVisible, setAdminPwdVisible] = useState(false);

  // Lists
  const [servers, setServers] = useState([]);
  const [cleanIps, setCleanIps] = useState([]);
  const [plans, setPlans] = useState([]);
  const [discounts, setDiscounts] = useState([]);
  const [testingServer, setTestingServer] = useState(null);
  const [serverTestResult, setServerTestResult] = useState(null);

  const [showIpForm, setShowIpForm] = useState(false);
  const [ipForm, setIpForm] = useState({ isp_name: "MCI", ip_address: "" });

  const [availableInbounds, setAvailableInbounds] = useState([]);
  const [defaultInboundIds, setDefaultInboundIds] = useState([]);
  const [savingDefaultInbounds, setSavingDefaultInbounds] = useState(false);

  const [showPlanForm, setShowPlanForm] = useState(false);
  const [planForm, setPlanForm] = useState({ plan_name: "", traffic_gb: 10, price_usd: 5 });
  const [editingPlan, setEditingPlan] = useState(null);

  const [showDiscountForm, setShowDiscountForm] = useState(false);
  const [discountForm, setDiscountForm] = useState({ code: "", discount_percent: 10, max_uses: "" });
  const [editingDiscount, setEditingDiscount] = useState(null);

  const [referralSettings, setReferralSettings] = useState({ layer_1: 5, layer_2: 3, layer_3: 2, layer_4: 1, layer_5: 0.5 });
  const [savingReferral, setSavingReferral] = useState(false);

  const [freeTrialSettings, setFreeTrialSettings] = useState({ traffic_gb: 0.2 });
  const [savingFreeTrial, setSavingFreeTrial] = useState(false);
  const [grantingFreeTrial, setGrantingFreeTrial] = useState(false);

  // Links
  const [linkSections, setLinkSections] = useState([])
  const [expandedLinkSection, setExpandedLinkSection] = useState(null)
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [editingLinkSection, setEditingLinkSection] = useState(null)
  const [linkForm, setLinkForm] = useState({ title: "", columns: { android: [], apple: [] } })
  const [savingLink, setSavingLink] = useState(false)

  const [userSearch, setUserSearch] = useState("");
  const [foundUser, setFoundUser] = useState(null);
  const [foundUsers, setFoundUsers] = useState([]);
  const [userTickets, setUserTickets] = useState([]);
  const [userLoans, setUserLoans] = useState([]);
  const [userConfigs, setUserConfigs] = useState([]);
  const [userConfigsLoading, setUserConfigsLoading] = useState(false);
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeType, setChargeType] = useState('wallet'); // 'wallet' or 'traffic'
  const [loanAmount, setLoanAmount] = useState('');
  const [loanNote, setLoanNote] = useState('');
  const [allocatingLoan, setAllocatingLoan] = useState(false);
  const [editingLoan, setEditingLoan] = useState(null); // loan object being edited
  const [editLoanAmount, setEditLoanAmount] = useState('');
  const [editLoanStatus, setEditLoanStatus] = useState('');
  const [savingLoan, setSavingLoan] = useState(false);
  const [deletingLoanId, setDeletingLoanId] = useState(null);
  // Admin password for user management
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [settingAdminPwd, setSettingAdminPwd] = useState(false);
  // Send message to user
  const [sendMsgText, setSendMsgText] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const [sendMsgResult, setSendMsgResult] = useState(null);
  // Broadcast
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcastTitle, setBroadcastTitle] = useState('')
  const [sendAsNotification, setSendAsNotification] = useState(true)
  const [sendViaTelegram, setSendViaTelegram] = useState(true)
  const [broadcastTarget, setBroadcastTarget] = useState('all');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState(null);
  // Top users - shown on stats tab
  const [topFilter, setTopFilter] = useState('most_unused_traffic');
  const [topLimit, setTopLimit] = useState(5);
  const [topUsers, setTopUsers] = useState([]);
  const [topUsersLoading, setTopUsersLoading] = useState(false);

  const fetchUsageForFoundUser = useCallback(async (timeframe, window, config) => {
    if (!foundUser) return [];
    const res = await getAdminUserUsageHistory(foundUser.telegram_id, timeframe, window, config);
    return res;
  }, [foundUser]);

  useEffect(() => {
    fetchStats();
    fetchTopUsers(topFilter, topLimit);
  }, [topFilter, topLimit]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    if (tab === "stats") { fetchStats(); fetchTopUsers(topFilter, topLimit); }
    if (tab === "servers") { fetchServers(); fetchCleanIps(); fetchInbounds(); }
    if (tab === "pricing") { fetchPlans(); fetchDiscounts(); fetchReferralSettings(); fetchFreeTrialSettings(); }
    if (tab === "links") { fetchLinkSections(); }
  };

  // Sync balance input when switching between wallet/traffic types
  useEffect(() => {
    if (!foundUser) return;
    setChargeAmount(String(
      chargeType === 'wallet'
        ? (foundUser.wallet_balance_usd ?? 0)
        : (foundUser.traffic_balance_gb ?? 0)
    ));
  }, [chargeType, foundUser]);

  const handleSendMessage = async () => {
    if (!sendMsgText.trim() || !foundUser) return;
    setSendingMsg(true);
    setSendMsgResult(null);
    try {
      await client.post('/api/v1/admin/users/send-message', {
        telegram_id: foundUser.telegram_id,
        message: sendMsgText.trim()
      });
      setSendMsgResult({ ok: true, msg: 'Message sent!' });
      setSendMsgText('');
    } catch (err) {
      setSendMsgResult({ ok: false, msg: err.response?.data?.detail || 'Failed to send message' });
    } finally {
      setSendingMsg(false);
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastMsg.trim()) return;
    if (!window.confirm(`Send broadcast to "${broadcastTarget}" group? This cannot be undone.`)) return;
    setBroadcasting(true);
    setBroadcastResult(null);
    try {
const data = await postAnnouncement({
          title: broadcastTitle.trim() || 'Announcement',
          message: broadcastMsg.trim(),
          target: broadcastTarget,
          send_as_notification: sendAsNotification,
          send_via_telegram: sendViaTelegram,
        });
      setBroadcastResult({ ok: true, data });
      setBroadcastMsg('');
      setBroadcastTitle('');
    } catch (err) {
      setBroadcastResult({ ok: false, msg: err.response?.data?.detail || 'Broadcast failed' });
    } finally {
      setBroadcasting(false);
    }
  };

  const fetchStats = async () => {
    try {
      setStatsError(null);
      const res = await client.get("/api/v1/admin/stats");
      setStats(res.data);
    } catch (err) {
      console.error("Failed to fetch stats", err);
      setStatsError(err.response?.data?.detail || err.message || "Failed to load stats");
    }
  };

  const fetchServers = async () => {
    try {
      const res = await client.get("/api/v1/admin/servers/");
      setServers(res.data);
    } catch (err) { console.error("Failed to fetch servers", err); }
  };

  const fetchCleanIps = async () => {
    try {
      const res = await client.get("/api/v1/clean-ips/");
      setCleanIps(res.data);
    } catch (err) { console.error("Failed to fetch clean IPs", err); }
  };

  const fetchPlans = async () => {
    try {
      const res = await client.get("/api/v1/plans/");
      setPlans(res.data);
    } catch (err) { console.error("Failed to fetch plans", err); }
  };

  const fetchDiscounts = async () => {
    try {
      const res = await client.get("/api/v1/discounts/");
      setDiscounts(res.data);
    } catch (err) { console.error("Failed to fetch discounts", err); }
  };

  const fetchReferralSettings = async () => {
    try {
      const res = await client.get("/api/v1/admin/referral-settings");
      setReferralSettings(res.data);
    } catch (err) { console.error("Failed to fetch referral settings", err); }
  };

  const fetchLinkSections = async () => {
    try {
      const data = await adminGetLinks()
      setLinkSections(data)
    } catch { toast("Failed to load links", 'error') }
  }

  const fetchTopUsers = async (filter, limit = topLimit) => {
    setTopUsersLoading(true);
    try {
      const res = await client.get(`/api/v1/admin/users/top?filter=${filter}&limit=${limit}`);
      setTopUsers(res.data || []);
    } catch (err) {
      console.error("Failed to fetch top users", err);
      setTopUsers([]);
    } finally {
      setTopUsersLoading(false);
    }
  };

  const fetchInbounds = async () => {
    try {
      const [list, defaultIds] = await Promise.all([
        getAvailableInbounds(),
        getDefaultInboundIds(),
      ]);
      setAvailableInbounds(list || []);
      setDefaultInboundIds(defaultIds?.inbound_ids || []);
    } catch (err) {
      console.error("Failed to fetch inbounds", err);
    }
  };

  const handleSaveDefaultInbounds = async () => {
    setSavingDefaultInbounds(true);
    try {
      await saveDefaultInboundIds(defaultInboundIds);
      toast("Available inbounds saved!");
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setSavingDefaultInbounds(false);
    }
  };

  const handleSaveReferralSettings = async () => {
    setSavingReferral(true);
    try {
      await client.put("/api/v1/admin/referral-settings", referralSettings);
      toast("Referral settings saved!");
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setSavingReferral(false);
    }
  };

  const fetchFreeTrialSettings = async () => {
    try {
      const res = await client.get("/api/v1/admin/free-trial-settings");
      setFreeTrialSettings(res.data);
    } catch (err) { console.error("Failed to fetch free trial settings", err); }
  };

  const handleSaveFreeTrialSettings = async () => {
    setSavingFreeTrial(true);
    try {
      await client.put("/api/v1/admin/free-trial-settings", freeTrialSettings);
      toast("Free trial settings saved!");
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setSavingFreeTrial(false);
    }
  };

  const handleGrantFreeTrial = async () => {
    setGrantingFreeTrial(true);
    try {
      const res = await client.post("/api/v1/admin/grant-free-trial");
      toast(`Free trial granted to ${res.data.affected_users} user(s)!`);
      setGrantingFreeTrial(false);
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
      setGrantingFreeTrial(false);
    }
  };

  const handleTestServer = async (serverName) => {
    setTestingServer(serverName);
    setServerTestResult(null);
    try {
      const res = await client.post(`/api/v1/admin/servers/${encodeURIComponent(serverName)}/test`);
      setServerTestResult({ name: serverName, ...res.data });
    } catch (err) {
      setServerTestResult({ name: serverName, status: "failed", error: err.response?.data?.detail || err.message });
    }
    setTestingServer(null);
  };

  const handleIpSubmit = async (e) => {
    e.preventDefault();
    try {
      await client.post("/api/v1/clean-ips/", ipForm);
      setIpForm({ isp_name: "MCI", ip_address: "" });
      setShowIpForm(false);
      await fetchCleanIps();
      toast("Clean IP added!");
    } catch (err) { toast("Error: " + (err.response?.data?.detail || err.message), 'error'); }
  };

  const deleteIp = async (isp, ip) => {
    if (!window.confirm("Delete IP?")) return;
    try {
      await client.delete(`/api/v1/clean-ips/${isp}/${ip}`);
      await fetchCleanIps();
      toast("IP deleted");
    } catch (_err) { toast("Error deleting IP", 'error'); }
  };

  const handleTopUserClick = (user) => {
    setActiveTab("users");
    setUserSearch(String(user.telegram_id));
    setTimeout(() => {
      client.get(`/api/v1/admin/users/search?q=${encodeURIComponent(String(user.telegram_id))}`)
        .then(res => {
          const results = res.data || [];
          if (results.length === 1) loadUserDetails(results[0]);
          else if (results.length > 1) setFoundUsers(results);
        })
        .catch(() => {});
    }, 50);
  };

  const handleUserSearch = async () => {
    if (!userSearch) return;
    setLoading(true);
    setFoundUser(null);
    setFoundUsers([]);
    setUserTickets([]);
    setUserLoans([]);
    try {
      const res = await client.get(`/api/v1/admin/users/search?q=${encodeURIComponent(userSearch)}`);
      const results = res.data || [];
      if (results.length === 1) {
        await loadUserDetails(results[0]);
      } else if (results.length > 1) {
        setFoundUsers(results);
      } else {
        toast("No users found", 'error');
      }
    } catch (err) { 
      toast("Search failed: " + (err.response?.data?.detail || err.message), 'error');
    }
    setLoading(false);
  };

  const loadUserDetails = async (user) => {
    setFoundUser(user);
    setFoundUsers([]);
    setUserConfigs([]);
    // Pre-populate balance editor with the user's current balance
    setChargeAmount(String(
      chargeType === 'wallet'
        ? (user.wallet_balance_usd ?? 0)
        : (user.traffic_balance_gb ?? 0)
    ));
    try {
      const [ticketsRes, loansRes] = await Promise.allSettled([
        client.get(`/api/v1/admin/users/${user.telegram_id}/tickets`),
        client.get(`/api/v1/loans/admin/user/${user.telegram_id}`),
      ]);
      setUserTickets(ticketsRes.status === 'fulfilled' ? ticketsRes.value.data || [] : []);
      setUserLoans(loansRes.status === 'fulfilled' ? loansRes.value.data || [] : []);
    } catch (err) {
      console.error("Failed to load user details", err);
    }
    // Load configs separately (can be slow)
    setUserConfigsLoading(true);
    try {
      const configsRes = await client.get(`/api/v1/configs/admin/user/${user.telegram_id}`);
      setUserConfigs(configsRes.data || []);
      const errorsHeader = configsRes.headers?.['x-config-errors'];
      if (errorsHeader) {
        try {
          const errors = JSON.parse(errorsHeader);
          errors.forEach(e => toast(e, 'error'));
        } catch (_e) { /* ignore parse errors */ }
      }
    } catch (err) {
      console.error("Failed to load user configs", err);
      setUserConfigs([]);
      toast("Failed to load user configs: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setUserConfigsLoading(false);
    }
  };

  const handleCharge = async () => {
    const amount = parseFloat(chargeAmount);
    if (isNaN(amount) || amount < 0) { toast("Enter a valid non-negative amount", 'error'); return; }
    try {
      if (chargeType === 'wallet') {
        await client.post(`/api/v1/users/${foundUser.telegram_id}/set_wallet?amount=${amount}`);
        toast(`Wallet set to $${amount}`);
      } else {
        await client.post(`/api/v1/users/${foundUser.telegram_id}/set_traffic?amount=${amount}`);
        toast(`Traffic set to ${amount} GB`);
      }
      const refreshed = await client.get(`/api/v1/admin/users/search?q=${foundUser.telegram_id}`);
      const results = refreshed.data || [];
      if (results.length > 0) {
        setFoundUser(results[0]);
        setChargeAmount(String(
          chargeType === 'wallet'
            ? (results[0].wallet_balance_usd ?? 0)
            : (results[0].traffic_balance_gb ?? 0)
        ));
      }
    } catch (err) { toast("Error: " + (err.response?.data?.detail || err.message), 'error'); }
  };

  const handleSaveLoan = async () => {
    if (!editingLoan) return;
    setSavingLoan(true);
    try {
      const payload = {};
      const amt = parseFloat(editLoanAmount);
      if (!isNaN(amt) && amt > 0) payload.amount_usdt = amt;
      if (editLoanStatus) payload.status = editLoanStatus;
      await client.put(`/api/v1/loans/admin/${editingLoan.loan_id}`, payload);
      setEditingLoan(null);
      await loadUserDetails(foundUser);
      toast("Loan updated!");
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setSavingLoan(false);
    }
  };

  const handleDeleteLoan = async (loan) => {
    if (!window.confirm(`Delete $${loan.amount_usdt?.toFixed(2)} loan for this user? This cannot be undone.`)) return;
    setDeletingLoanId(loan.loan_id);
    try {
      await client.delete(`/api/v1/loans/admin/${loan.loan_id}`);
      await loadUserDetails(foundUser);
      toast("Loan deleted!");
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setDeletingLoanId(null);
    }
  };

  const handleRoleChange = async (newRole) => {
    try {
      await client.put(`/api/v1/admin/users/${foundUser.telegram_id}/role`, { role: newRole });
      setNewAdminPassword('');
      await loadUserDetails(foundUser);
      toast("Role updated!");
    } catch (err) { toast("Error updating role: " + (err.response?.data?.detail || err.message), 'error'); }
  };

  const handleSetAdminPassword = async () => {
    if (!newAdminPassword.trim() || newAdminPassword.trim().length < 4) {
      toast("Password must be at least 4 characters", 'error');
      return;
    }
    setSettingAdminPwd(true);
    try {
      await setAdminPasswordForUser(foundUser.telegram_id, newAdminPassword.trim());
      setNewAdminPassword('');
      await loadUserDetails(foundUser);
      toast("Admin password set!");
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setSettingAdminPwd(false);
    }
  };

  const handleAllocateLoan = async () => {
    const amount = parseFloat(loanAmount);
    if (!amount || amount <= 0) { toast("Enter a valid loan amount", 'error'); return; }
    setAllocatingLoan(true);
    try {
      await client.post('/api/v1/loans/admin/allocate', {
        telegram_id: foundUser.telegram_id,
        amount_usdt: amount,
        note: loanNote || null,
      });
      setLoanAmount('');
      setLoanNote('');
      await loadUserDetails(foundUser);
      toast(`Loan of $${amount} USDT allocated!`);
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error');
    } finally {
      setAllocatingLoan(false);
    }
  };

  const handlePlanSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingPlan) {
        await client.put(`/api/v1/plans/${editingPlan}`, { traffic_gb: planForm.traffic_gb, price_usd: planForm.price_usd });
      } else {
        await client.post("/api/v1/plans/", { plan_name: planForm.plan_name, traffic_gb: planForm.traffic_gb, price_usd: planForm.price_usd });
      }
      setPlanForm({ plan_name: "", traffic_gb: 10, price_usd: 5 });
      setEditingPlan(null);
      setShowPlanForm(false);
      await fetchPlans();
      toast("Plan saved!");
    } catch (err) { toast("Error: " + (err.response?.data?.detail || err.message), 'error'); }
  };

  const deletePlan = async (name) => {
    if (!window.confirm("Delete plan?")) return;
    try {
      await client.delete(`/api/v1/plans/${name}`);
      await fetchPlans();
      toast("Plan deleted");
    } catch (_err) { toast("Error deleting plan", 'error'); }
  };

  const handleDiscountSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      code: discountForm.code,
      discount_percent: discountForm.discount_percent,
      ...(discountForm.max_uses !== "" && discountForm.max_uses !== null
        ? { max_uses: parseInt(discountForm.max_uses, 10) }
        : {}),
    };
    try {
      if (editingDiscount) {
        const updatePayload = {
          discount_percent: discountForm.discount_percent,
          ...(discountForm.max_uses !== "" && discountForm.max_uses !== null
            ? { max_uses: parseInt(discountForm.max_uses, 10) }
            : {}),
        };
        await client.put(`/api/v1/discounts/${editingDiscount}`, updatePayload);
      } else {
        await client.post("/api/v1/discounts/", payload);
      }
      setDiscountForm({ code: "", discount_percent: 10, max_uses: "" });
      setEditingDiscount(null);
      setShowDiscountForm(false);
      await fetchDiscounts();
      toast("Discount saved!");
    } catch (err) { toast("Error: " + (err.response?.data?.detail || err.message), 'error'); }
  };

  const deleteDiscount = async (code) => {
    if (!window.confirm("Delete discount?")) return;
    try {
      await client.delete(`/api/v1/discounts/${code}`);
      await fetchDiscounts();
      toast("Discount deleted");
    } catch (_err) { toast("Error deleting discount", 'error'); }
  };

  const handleLinkSubmit = async (e) => {
    e.preventDefault()
    setSavingLink(true)
    try {
      if (editingLinkSection) {
        await adminUpdateLinkSection(editingLinkSection, linkForm)
      } else {
        await adminAddLinkSection(linkForm)
      }
      setLinkForm({ title: "", columns: { android: [], apple: [] } })
      setEditingLinkSection(null)
      setShowLinkForm(false)
      await fetchLinkSections()
      toast("Link section saved!")
    } catch (err) {
      toast("Error: " + (err.response?.data?.detail || err.message), 'error')
    } finally { setSavingLink(false) }
  }

  const handleDeleteLinkSection = async (title) => {
    if (!window.confirm(`Delete section "${title}"?`)) return
    try {
      await adminDeleteLinkSection(title)
      await fetchLinkSections()
      toast("Section deleted")
    } catch { toast("Error deleting section", 'error') }
  }

  const handleUnlockAdmin = async (e) => {
    e.preventDefault();
    if (!adminPwdInput.trim()) return;
    setAdminPwdLoading(true);
    setAdminPwdError(null);
    try {
      await verifyAdminPassword(adminPwdInput.trim());
      setAdminPasswordHeader(adminPwdInput.trim());
      setAdminUnlocked(true);
    } catch (err) {
      setAdminPwdError(err.response?.data?.detail || 'Invalid password');
    } finally {
      setAdminPwdLoading(false);
    }
  };

  if (user?.role !== "admin") {
    return <div className="p-8 text-center text-slate-400">Access Denied. Admins only.</div>;
  }

  // If the admin has a 2FA password configured, show password gate until unlocked
  if (user?.has_admin_password && !adminUnlocked) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] px-4">
        <div className="w-full max-w-xs bg-slate-800 border border-slate-700 rounded-3xl p-6 space-y-5">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto">
              <FiLock className="text-emerald-400" size={24} />
            </div>
            <h2 className="text-white font-bold text-lg">Admin Dashboard</h2>
            <p className="text-slate-400 text-xs">Enter your admin password to continue</p>
          </div>
          <form onSubmit={handleUnlockAdmin} className="space-y-3">
            <div className="relative">
              <input
                type={adminPwdVisible ? "text" : "password"}
                placeholder="Admin password"
                value={adminPwdInput}
                onChange={e => { setAdminPwdInput(e.target.value); setAdminPwdError(null); }}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm pe-10 focus:outline-none focus:border-emerald-500 transition-colors"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setAdminPwdVisible(v => !v)}
                className="absolute end-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300"
              >
                {adminPwdVisible ? <FiEyeOff size={15} /> : <FiEye size={15} />}
              </button>
            </div>
            {adminPwdError && (
              <p className="text-rose-400 text-xs flex items-center gap-1.5">
                <FiX size={11} /> {adminPwdError}
              </p>
            )}
            <button
              type="submit"
              disabled={adminPwdLoading || !adminPwdInput.trim()}
              className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white font-bold rounded-xl transition-colors text-sm"
            >
              {adminPwdLoading ? 'Verifying…' : 'Unlock Dashboard'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 pb-24 max-w-2xl mx-auto">
      <Toast toasts={toasts} />
      <h1 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
        <FiBarChart2 className="text-emerald-500" />
        {t('dashboard.title')}
      </h1>
      
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2 no-scrollbar">
        {[
          { id: "stats", label: t('tabs.stats'), icon: FiBarChart2 },
          { id: "servers", label: t('tabs.servers'), icon: FiServer },
          { id: "users", label: t('tabs.users'), icon: FiUsers },
          { id: "broadcast", label: t('tabs.broadcast'), icon: FiRadio },
          { id: "pricing", label: t('tabs.pricing'), icon: FiTag },
          { id: "links", label: t('tabs.links'), icon: FiLink }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium capitalize transition-all flex items-center gap-2 whitespace-nowrap ${
              activeTab === tab.id ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "stats" && statsError && (
        <div className="p-6 text-center">
          <p className="text-rose-400 text-sm mb-2">{t('stats.failedLoad')}</p>
          <p className="text-slate-500 text-xs">{statsError}</p>
          <button onClick={fetchStats} className="mt-3 px-4 py-2 bg-slate-700 text-white text-xs rounded-lg hover:bg-slate-600 transition-colors">{t('stats.retry')}</button>
        </div>
      )}
      {activeTab === "stats" && !stats && !statsError && (
        <div className="p-6 text-center">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-500 text-xs mt-3">{t('stats.loading')}</p>
        </div>
      )}
      {activeTab === "stats" && stats && !statsError && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-2 gap-4">
            <Card><div className="text-xs text-slate-400">Total Users</div><div className="text-xl font-bold text-white">{stats.total_users}</div></Card>
            <Card><div className="text-xs text-slate-400">Revenue</div><div className="text-xl font-bold text-emerald-400">${stats.total_revenue_usd}</div></Card>
            <Card><div className="text-xs text-slate-400">Active Configs</div><div className="text-xl font-bold text-blue-400">{stats.active_configs}</div></Card>
            <Card><div className="text-xs text-slate-400">Open Tickets</div><div className="text-xl font-bold text-rose-400">{stats.open_tickets}</div></Card>
            <Card><div className="text-xs text-slate-400">Unsettled Loans</div><div className="text-xl font-bold text-amber-400">${stats.total_unsettled_loans_usd ?? '—'}</div></Card>
            <Card><div className="text-xs text-slate-400">Unused Traffic</div><div className="text-xl font-bold text-cyan-400">{stats.total_unused_traffic_gb ?? '—'} GB</div></Card>
          </div>

          {/* Top Users */}
          <div className="p-3 bg-slate-900/50 rounded-xl border border-slate-700 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Top {topLimit} Users</span>
              {topUsersLoading && <span className="w-3.5 h-3.5 border border-slate-500 border-t-transparent rounded-full animate-spin" />}
            </div>
            <div className="flex gap-2">
              <select
                value={topFilter}
                onChange={e => { setTopFilter(e.target.value); setTopUsers([]); fetchTopUsers(e.target.value, topLimit); }}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                <option value="most_unused_traffic">Most Unused Traffic</option>
                <option value="most_used_traffic_1d">Most Used Traffic (24h)</option>
                <option value="most_used_traffic_7d">Most Used Traffic (7d)</option>
                <option value="most_purchases">Most Purchases</option>
                <option value="most_unsettled_loans">Most Unsettled Loans</option>
                <option value="most_configs">Most Configs</option>
                <option value="recently_joined">Recently Joined</option>
              </select>
              <select
                value={topLimit}
                onChange={e => { const v = parseInt(e.target.value); setTopLimit(v); setTopUsers([]); fetchTopUsers(topFilter, v); }}
                className="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-white text-xs text-center focus:outline-none focus:border-emerald-500"
              >
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="20">20</option>
              </select>
            </div>
            {topUsers.length > 0 && (
              <div className="space-y-1.5 mt-1">
                {topUsers.map((u, idx) => (
                  <div
                    key={u.telegram_id}
                    onClick={() => handleTopUserClick(u)}
                    className="w-full p-2 bg-slate-800/60 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-700/60 hover:border-emerald-500/50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-slate-500 w-4">#{idx + 1}</span>
                        <div>
                          <span className="text-xs font-bold text-white">{u.display_name}</span>
                          {u.username && <span className="text-[10px] text-slate-400 ms-1">@{u.username}</span>}
                          <div className="text-[10px] text-slate-500">{u.telegram_id}</div>
                        </div>
                      </div>
                      <div className="text-end">
                        <span className="text-xs font-bold text-emerald-400">
                          {topFilter === 'recently_joined' ? '' : u.value}
                          <span className="text-[10px] text-slate-500"> {u.metric}</span>
                        </span>
                        {topFilter === 'recently_joined' && u.value && (
                          <div className="text-[9px] text-slate-400">{formatDateTime(u.value)}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!topUsersLoading && topUsers.length === 0 && (
              <p className="text-[10px] text-slate-600 text-center py-1">No data</p>
            )}
          </div>
        </div>
      )}

      {activeTab === "servers" && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <ServerUsageChart servers={servers} />
          <Card>
            <SectionHeader title="XUI Servers" icon={FiServer} />
            <div className="mb-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
              <p className="text-xs text-amber-400">
                🔒 Server credentials are stored securely in the <code className="bg-slate-900 px-1 rounded">.env</code> file.
                Edit the <code className="bg-slate-900 px-1 rounded">SERVERS</code> variable and restart the server to make changes.
                Sensitive fields (username, password) are not shown here.
              </p>
            </div>
            <div className="space-y-2">
              {servers.length === 0 && (
                <p className="text-slate-500 text-sm text-center py-4">No servers configured in .env</p>
              )}
              {servers.map(s => (
                <div key={s.name} className="p-3 bg-slate-900/30 rounded-xl border border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white">{s.name}</span>
                        <Badge variant={s.status === "enabled" ? "success" : "danger"}>{s.status}</Badge>
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{s.ip}:{s.port} | Inbound: {s.inbound_id}</div>
                    </div>
                    <button
                      onClick={() => handleTestServer(s.name)}
                      disabled={testingServer === s.name}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                    >
                      {testingServer === s.name ? (
                        <span className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                      ) : <FiZap size={12} />}
                      Test
                    </button>
                  </div>
                  {serverTestResult?.name === s.name && (
                    <div className={`mt-2 p-2 rounded-lg text-xs ${serverTestResult.status === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                      {serverTestResult.status === 'success' ? (
                        <div className="space-y-0.5">
                          <div>✓ Connected | Inbounds: {serverTestResult.inbounds_count}</div>
                          <div className="flex gap-4 text-emerald-300 mt-1">
                            <span>↑ Upload: {serverTestResult.inbound_up_gb ?? 0} GB</span>
                            <span>↓ Download: {serverTestResult.inbound_down_gb ?? 0} GB</span>
                            <span className="text-emerald-400 font-bold">Total: {((serverTestResult.inbound_up_gb ?? 0) + (serverTestResult.inbound_down_gb ?? 0)).toFixed(3)} GB</span>
                          </div>
                        </div>
                      ) : `✗ Failed: ${serverTestResult.error}`}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionHeader title="Available Inbounds" icon={FiBarChart2} />
            <p className="text-xs text-slate-500 mb-3">
              Select inbounds that users can attach when creating new configs.
            </p>

            {availableInbounds.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4">Loading inbounds…</p>
            ) : (
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {availableInbounds.map(ib => (
                  <label key={`${ib.server_name}-${ib.id}`} className="flex items-center gap-3 p-2 bg-slate-900/30 rounded-lg border border-slate-700/50 cursor-pointer hover:border-emerald-500/30 transition-colors">
                    <input
                      type="checkbox"
                      checked={defaultInboundIds.includes(ib.id)}
                      onChange={() => {
                        setDefaultInboundIds(prev =>
                          prev.includes(ib.id)
                            ? prev.filter(id => id !== ib.id)
                            : [...prev, ib.id]
                        );
                      }}
                      className="w-3.5 h-3.5 accent-emerald-500"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-white truncate block">{ib.remark}</span>
                      <span className="text-[10px] text-slate-500">ID: {ib.id} · {ib.server_name}</span>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <Button
              onClick={handleSaveDefaultInbounds}
              disabled={savingDefaultInbounds}
              className="w-full mt-3"
            >
              {savingDefaultInbounds ? 'Saving…' : 'Save Available Inbounds'}
            </Button>
          </Card>

          <Card>
            <SectionHeader title="Clean IPs" icon={FiCheck} onAdd={() => setShowIpForm(!showIpForm)} />
            {showIpForm && (
              <form onSubmit={handleIpSubmit} className="mb-6 p-4 bg-slate-900/50 rounded-xl border border-slate-700 animate-in zoom-in-95 duration-200">
                <Select label="ISP Name" value={ipForm.isp_name} onChange={e => setIpForm({...ipForm, isp_name: e.target.value})} options={["MCI", "MTN", "TUN"]} />
                <Input label="IP Address" value={ipForm.ip_address} onChange={e => setIpForm({...ipForm, ip_address: e.target.value})} required />
                <div className="flex gap-2">
                  <Button type="submit" className="flex-1">Add IP</Button>
                  <Button type="button" variant="outline" onClick={() => setShowIpForm(false)}>Cancel</Button>
                </div>
              </form>
            )}
            <div className="grid grid-cols-1 gap-2">
              {cleanIps.map((ip, idx) => (
                <div key={idx} className="p-2 bg-slate-900/30 rounded-lg border border-slate-700/50 flex items-center justify-between group">
                  <div className="flex items-center gap-3">
                    <Badge variant="info">{ip.isp_name}</Badge>
                    <span className="text-xs text-slate-300 font-mono">{ip.ip_address}</span>
                  </div>
                  <button onClick={() => deleteIp(ip.isp_name, ip.ip_address)} className="p-1 hover:bg-rose-500/20 text-rose-400 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                    <FiTrash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {activeTab === "users" && (
        <Card className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <SectionHeader title="Users" icon={FiUsers} />
          <div className="flex gap-2 mb-3">
            <input 
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 outline-none" 
              placeholder="ID, @username, phone, name…" 
              value={userSearch} 
              onChange={e => setUserSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUserSearch()}
            />
            <Button onClick={handleUserSearch} disabled={loading} icon={loading ? FiRefreshCw : null}>
              {loading ? "" : "Search"}
            </Button>
          </div>

          {/* Multi-result list */}
          {foundUsers.length > 1 && !foundUser && (
            <div className="space-y-1.5 mb-3">
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">{foundUsers.length} results</div>
              {foundUsers.map(u => (
                <button
                  key={u.telegram_id}
                  onClick={() => loadUserDetails(u)}
                  className="w-full p-2.5 bg-slate-900/50 rounded-xl border border-slate-700 text-start hover:border-emerald-500/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold text-white">
                        {u.nickname || u.telegram_info?.first_name || `ID: ${u.telegram_id}`}
                        {u.telegram_info?.username && <span className="text-slate-400 font-normal ms-1">@{u.telegram_info.username}</span>}
                      </div>
                      <div className="text-[10px] text-slate-500">{u.telegram_id} · ${u.wallet_balance_usd?.toFixed(2)}</div>
                    </div>
                    <Badge variant={u.role === "admin" ? "warning" : "info"}>{u.role}</Badge>
                  </div>
                </button>
              ))}
            </div>
          )}

          {foundUser && (
            <div className="space-y-2.5 animate-in zoom-in-95 duration-300">
              {foundUsers.length > 1 && (
                <button onClick={() => setFoundUser(null)} className="flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-emerald-400 transition-colors group">
                  <FiChevronDown size={12} className="rotate-90 group-hover:-translate-x-0.5 transition-transform" />
                  Back to results
                </button>
              )}

              {/* ── User header ─────────────────────────────────────────── */}
              <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800/60">
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />
                <div className="p-3 flex items-center gap-3">
                  {foundUser.telegram_info?.photo_url ? (
                    <img src={foundUser.telegram_info.photo_url} alt="avatar" className="w-10 h-10 rounded-full object-cover border border-slate-600 flex-shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
                      <FiUsers size={16} className="text-slate-500" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-white truncate">
                        {foundUser.nickname || foundUser.telegram_info?.first_name || `User ${foundUser.telegram_id}`}
                      </span>
                      {foundUser.telegram_info?.last_name && (
                        <span className="text-sm text-slate-300 truncate">{foundUser.telegram_info.last_name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      {foundUser.telegram_info?.username && (
                        <span className="text-[10px] text-slate-400">@{foundUser.telegram_info.username}</span>
                      )}
                      <span className="text-[10px] text-slate-600 font-mono">#{foundUser.telegram_id}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Badge variant={foundUser.role === "admin" ? "warning" : "info"}>{foundUser.role}</Badge>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${
                      foundUser.has_used_free_trial
                        ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }`}>
                      {foundUser.has_used_free_trial ? "Trial used" : "Trial free"}
                    </span>
                  </div>
                </div>

                {/* metric strip */}
                <div className="grid grid-cols-3 divide-x divide-slate-700/60 border-t border-slate-700/60 bg-slate-900/40">
                  <div className="px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-500 font-medium">Wallet</div>
                    <div className="text-emerald-400 font-bold text-sm font-mono mt-0.5">${(foundUser.wallet_balance_usd || 0).toFixed(2)}</div>
                  </div>
                  <div className="px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-500 font-medium">Traffic</div>
                    <div className="text-blue-400 font-bold text-sm font-mono mt-0.5">{(foundUser.traffic_balance_gb || 0).toFixed(1)} <span className="text-[10px] text-blue-400/60">GB</span></div>
                  </div>
                  <div className="px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-500 font-medium">Unpaid loans</div>
                    <div className="text-rose-400 font-bold text-sm font-mono mt-0.5">
                      ${userLoans.filter(l => l.status === 'unpaid').reduce((s, l) => s + l.amount_usdt, 0).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Access & 2FA / Balance editor — two-column compact ──── */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {/* Role + 2FA */}
                <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                    <FiLock size={10} className="text-emerald-400" /> Access
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 w-9 flex-shrink-0">Role</span>
                    <select
                      value={foundUser.role}
                      onChange={(e) => handleRoleChange(e.target.value)}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
                    >
                      <option value="user">User</option>
                      <option value="support">Support</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  {foundUser.role === "admin" && (
                    <div className="flex items-center gap-2 pt-2 border-t border-slate-700/60">
                      <FiLock size={11} className="text-amber-400 flex-shrink-0" />
                      <input
                        type="password"
                        placeholder={`2FA password${foundUser.has_admin_password ? ' (set ✓)' : ''}`}
                        value={newAdminPassword}
                        onChange={e => setNewAdminPassword(e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500"
                      />
                      <button
                        onClick={handleSetAdminPassword}
                        disabled={settingAdminPwd || !newAdminPassword.trim()}
                        className="px-2.5 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-50 text-amber-400 text-[11px] font-bold rounded-lg border border-amber-500/30 transition-colors"
                      >
                        {settingAdminPwd ? '…' : 'Set'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Balance editor */}
                <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                    <FiZap size={10} className="text-emerald-400" /> Set balance
                  </div>
                  <div className="flex gap-2 items-stretch">
                    <div className="flex rounded-lg border border-slate-700 overflow-hidden text-[11px] font-bold flex-shrink-0">
                      <button onClick={() => setChargeType('wallet')} className={`px-2.5 transition-colors ${chargeType === 'wallet' ? 'bg-emerald-500 text-white' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'}`}>$</button>
                      <button onClick={() => setChargeType('traffic')} className={`px-2.5 transition-colors ${chargeType === 'traffic' ? 'bg-blue-500 text-white' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'}`}>GB</button>
                    </div>
                    <input
                      type="number"
                      value={chargeAmount}
                      onChange={e => setChargeAmount(e.target.value)}
                      placeholder={chargeType === 'wallet' ? '0.00' : '0.0'}
                      min="0"
                      step="0.01"
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-emerald-500"
                    />
                    <Button onClick={handleCharge} variant="primary" disabled={chargeAmount === ''} className="px-3 py-1.5 text-xs flex-shrink-0">Set</Button>
                  </div>
                  <div className="text-[10px] text-slate-500 leading-tight">Sets exact balance — below current decreases, above increases.</div>
                </div>
              </div>

              {/* ── Message + Loan allocation — two-column compact ─────── */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {/* Send Message */}
                <div className="rounded-xl border border-blue-500/25 bg-slate-900/60 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-blue-400 uppercase tracking-wider">
                    <FiMessageSquare size={10} /> Message
                  </div>
                  <textarea
                    value={sendMsgText}
                    onChange={e => setSendMsgText(e.target.value)}
                    placeholder="Type a message to send to this user…"
                    rows={2}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500 resize-none"
                  />
                  {sendMsgResult && (
                    <div className={`text-[11px] px-2 py-1.5 rounded-lg border ${
                      sendMsgResult.ok
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                    }`}>
                      {sendMsgResult.msg}
                    </div>
                  )}
                  <button
                    onClick={handleSendMessage}
                    disabled={sendingMsg || !sendMsgText.trim()}
                    className="w-full px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 bg-slate-700 hover:bg-slate-600 text-white"
                  >
                    {sendingMsg ? <FiRefreshCw size={12} className="animate-spin" /> : <FiSend size={12} />}
                    {sendingMsg ? 'Sending…' : 'Send'}
                  </button>
                </div>

                {/* Loan Allocation */}
                <div className="rounded-xl border border-rose-500/25 bg-slate-900/60 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-rose-400 uppercase tracking-wider">
                    <FiZap size={10} className="rotate-45" /> Allocate loan
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={loanAmount}
                      onChange={e => setLoanAmount(e.target.value)}
                      placeholder="USDT"
                      min="0"
                      step="0.01"
                      className="w-20 flex-shrink-0 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-rose-500"
                    />
                    <input
                      value={loanNote}
                      onChange={e => setLoanNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-rose-500"
                    />
                  </div>
                  <button
                    onClick={handleAllocateLoan}
                    disabled={allocatingLoan || !loanAmount}
                    className="w-full px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 bg-rose-500 hover:bg-rose-600 text-white"
                  >
                    {allocatingLoan ? <FiRefreshCw size={12} className="animate-spin" /> : null}
                    {allocatingLoan ? 'Allocating…' : 'Allocate loan'}
                  </button>
                </div>
              </div>

              {/* ── Loans + Tickets — side-by-side when both present ───── */}
              {(userLoans.length > 0 || userTickets.length > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {/* Loans list with edit */}
                  {userLoans.length > 0 && (
                    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Loans</div>
                        <span className="text-[10px] text-slate-600 font-mono">{userLoans.length}</span>
                      </div>
                      {userLoans.map(loan => (
                        <div key={loan.loan_id}>
                          <div className={`p-2 rounded-lg border flex items-center justify-between gap-2 ${loan.status === 'settled' ? 'bg-emerald-500/5 border-emerald-500/25' : 'bg-rose-500/5 border-rose-500/25'}`}>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold text-white font-mono">${loan.amount_usdt?.toFixed(2)}</span>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${loan.status === 'settled' ? 'text-emerald-400 border-emerald-500/30' : 'text-rose-400 border-rose-500/30'}`}>
                                  {loan.status === 'settled' ? 'settled' : 'unpaid'}
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-500 truncate mt-0.5">
                                {formatDateShort(loan.created_at)}{loan.note && ` · ${loan.note}`}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => { setEditingLoan(loan); setEditLoanAmount(String(loan.amount_usdt)); setEditLoanStatus(loan.status); }}
                                className="p-1.5 hover:bg-slate-700 text-slate-400 hover:text-white rounded transition-colors flex-shrink-0"
                                title="Edit loan"
                              >
                                <FiEdit2 size={11} />
                              </button>
                              <button
                                onClick={() => handleDeleteLoan(loan)}
                                disabled={deletingLoanId === loan.loan_id}
                                className="p-1.5 hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 rounded transition-colors flex-shrink-0 disabled:opacity-40"
                                title="Delete loan"
                              >
                                {deletingLoanId === loan.loan_id ? <FiRefreshCw size={11} className="animate-spin" /> : <FiTrash2 size={11} />}
                              </button>
                            </div>
                          </div>
                          {editingLoan?.loan_id === loan.loan_id && (
                            <div className="mt-1.5 p-2 bg-slate-900 rounded-lg border border-slate-600 space-y-2 animate-in zoom-in-95 duration-200">
                              <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Edit loan</div>
                              <div className="flex gap-2">
                                <input
                                  type="number"
                                  value={editLoanAmount}
                                  onChange={e => setEditLoanAmount(e.target.value)}
                                  placeholder="USDT"
                                  min="0.01"
                                  step="0.01"
                                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-emerald-500"
                                />
                                <select
                                  value={editLoanStatus}
                                  onChange={e => setEditLoanStatus(e.target.value)}
                                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
                                >
                                  <option value="unpaid">Unpaid</option>
                                  <option value="settled">Settled</option>
                                </select>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  onClick={handleSaveLoan}
                                  disabled={savingLoan}
                                  className="flex-1 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1"
                                >
                                  {savingLoan ? <FiRefreshCw size={11} className="animate-spin" /> : <FiCheck size={11} />}
                                  {savingLoan ? '…' : 'Save'}
                                </button>
                                <button
                                  onClick={() => setEditingLoan(null)}
                                  className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1"
                                >
                                  <FiX size={11} /> Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tickets list */}
                  {userTickets.length > 0 && (
                    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Tickets</div>
                        <span className="text-[10px] text-slate-600 font-mono">{userTickets.length}</span>
                      </div>
                      {userTickets.map(ticket => (
                        <div key={ticket.ticket_id} className="p-2 bg-slate-800/40 rounded-lg border border-slate-700/40 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-white truncate">{ticket.title || `#${ticket.ticket_id.slice(0, 8)}`}</div>
                            <div className="text-[10px] text-slate-500 truncate mt-0.5">{ticket.category}</div>
                          </div>
                          <Badge variant={ticket.status === 'open' ? 'danger' : ticket.status === 'closed' ? 'info' : 'warning'}>
                            {ticket.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Usage History */}
              {foundUser && (
                <UsageHistogram configs={userConfigs} fetchUsageHistory={fetchUsageForFoundUser} />
              )}

              {/* User Configs */}
              <div className="p-3 bg-slate-900/50 rounded-xl border border-slate-700 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Configs {userConfigs.length > 0 && `(${userConfigs.length})`}</div>
                  {userConfigsLoading && <span className="w-3 h-3 border border-slate-500 border-t-transparent rounded-full animate-spin" />}
                </div>
                {!userConfigsLoading && userConfigs.length === 0 && (
                  <p className="text-[10px] text-slate-600 text-center py-2">No configs found</p>
                )}
                {userConfigs.map(cfg => {
                  const usedGb = ((cfg.usage_up || 0) + (cfg.usage_down || 0)) / (1024 ** 3);
                  const totalGb = cfg.total_gb || 0;
                  const pct = totalGb > 0 ? Math.min(100, Math.round((usedGb / totalGb) * 100)) : 0;
                  const barColor = pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-emerald-500';
                  const expiryDate = cfg.expiry_date ? new Date(cfg.expiry_date) : null;
                  const daysLeft = expiryDate ? Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24)) : null;
                  const statusColor = cfg.status === 'active' ? 'text-emerald-400' : cfg.status === 'expired' ? 'text-amber-400' : 'text-slate-500';
                  return (
                    <div key={cfg.uuid} className="p-2.5 bg-slate-800/60 rounded-xl border border-slate-700/50 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-xs font-bold text-white">{cfg.name}</span>
                          <span className="text-[10px] text-slate-500 ms-1.5">{cfg.server_name}</span>
                        </div>
                        <span className={`text-[10px] font-bold ${statusColor}`}>{cfg.status}</span>
                      </div>
                      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-500">
                        <span>{usedGb.toFixed(2)} / {totalGb.toFixed(1)} GB ({pct}%)</span>
                        {daysLeft !== null && (
                          <span>{daysLeft > 0 ? `${daysLeft}d left` : 'Expired'}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      )}

      {activeTab === "broadcast" && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card>
            <SectionHeader title="Broadcast" icon={FiRadio} />
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  { value: 'all', label: 'All Users', color: 'emerald' },
                  { value: 'unpaid_loans', label: 'Unpaid Loans', color: 'rose' },
                  { value: 'active_configs', label: 'Active Configs', color: 'blue' }
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setBroadcastTarget(opt.value)}
                    className={`p-2.5 rounded-xl border text-start transition-all ${
                      broadcastTarget === opt.value
                        ? 'border-emerald-500/50 bg-emerald-500/10'
                        : 'border-slate-700 bg-slate-900/30 hover:border-slate-600'
                    }`}
                  >
                    <div className={`text-sm font-bold ${
                      broadcastTarget === opt.value ? 'text-emerald-400' : 'text-white'
                    }`}>{opt.label}</div>
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={broadcastTitle}
                onChange={e => setBroadcastTitle(e.target.value)}
                placeholder="Title (optional, defaults to 'Announcement')"
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
              <textarea
                value={broadcastMsg}
                onChange={e => setBroadcastMsg(e.target.value)}
                placeholder="Message… (HTML supported: <b>bold</b>)"
                rows={4}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-emerald-500 resize-none"
              />
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendAsNotification}
                    onChange={e => setSendAsNotification(e.target.checked)}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <span className="text-sm text-slate-300">Send as in-app notification</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendViaTelegram}
                    onChange={e => setSendViaTelegram(e.target.checked)}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <span className="text-sm text-slate-300">Send via Telegram</span>
                </label>
              </div>
              {broadcastResult && (
                <div className={`p-3 rounded-xl border text-sm ${
                  broadcastResult.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                }`}>
                  {broadcastResult.ok ? (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="font-bold">✓ Done</span>
                      <span>Sent: {broadcastResult.data?.sent}</span>
                      <span>Failed: {broadcastResult.data?.failed}</span>
                      <span>Total: {broadcastResult.data?.total}</span>
                    </div>
                  ) : (
                    <div>✗ {broadcastResult.msg}</div>
                  )}
                </div>
              )}
              <Button
                onClick={handleBroadcast}
                disabled={broadcasting || !broadcastMsg.trim() || (!sendAsNotification && !sendViaTelegram)}
                icon={FiSend}
                variant="primary"
                className="w-full"
              >
                {broadcasting ? 'Broadcasting...' : `Send Broadcast to ${broadcastTarget === 'all' ? 'All Users' : broadcastTarget === 'unpaid_loans' ? 'Users with Unpaid Loans' : 'Users with Active Configs'}`}
              </Button>
            </div>
          </Card>

        </div>
      )}
      {activeTab === "links" && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card>
            <SectionHeader title="Links" icon={FiLink} onAdd={() => { setShowLinkForm(!showLinkForm); setEditingLinkSection(null); setLinkForm({ title: "", columns: { android: [], apple: [] } }); }} />
            {showLinkForm && (
              <form onSubmit={handleLinkSubmit} className="mb-6 p-4 bg-slate-900/50 rounded-xl border border-slate-700 animate-in zoom-in-95 duration-200">
                <Input label="Section Title" value={linkForm.title} onChange={e => setLinkForm({...linkForm, title: e.target.value})} required placeholder="e.g. Download app" />
                <div className="space-y-3">
                  {Object.entries(linkForm.columns).map(([colKey, items]) => (
                    <div key={colKey} className="p-3 bg-slate-900/30 rounded-lg border border-slate-700/50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-slate-300 uppercase">{colKey}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const newItems = [...items, { label: "", url: "" }]
                            setLinkForm({...linkForm, columns: {...linkForm.columns, [colKey]: newItems}})
                          }}
                          className="text-[10px] text-emerald-400 hover:text-emerald-300 font-medium"
                        >
                          + Add item
                        </button>
                      </div>
                      <div className="space-y-2">
                        {items.map((item, i) => (
                          <div key={i} className="flex gap-2 items-start">
                            <div className="flex-1 space-y-1">
                              <input
                                type="text"
                                placeholder="Label"
                                value={item.label}
                                onChange={e => {
                                  const copy = [...items]
                                  copy[i] = {...copy[i], label: e.target.value}
                                  setLinkForm({...linkForm, columns: {...linkForm.columns, [colKey]: copy}})
                                }}
                                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
                              />
                              <input
                                type="text"
                                placeholder="URL"
                                value={item.url}
                                onChange={e => {
                                  const copy = [...items]
                                  copy[i] = {...copy[i], url: e.target.value}
                                  setLinkForm({...linkForm, columns: {...linkForm.columns, [colKey]: copy}})
                                }}
                                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const copy = items.filter((_, idx) => idx !== i)
                                setLinkForm({...linkForm, columns: {...linkForm.columns, [colKey]: copy}})
                              }}
                              className="p-1.5 text-rose-400 hover:bg-rose-500/20 rounded-lg mt-1"
                            >
                              <FiTrash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button type="submit" className="flex-1" disabled={savingLink || !linkForm.title.trim()}>
                    {savingLink ? "Saving…" : editingLinkSection ? "Update Section" : "Create Section"}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => { setShowLinkForm(false); setEditingLinkSection(null); }}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {linkSections.length === 0 && !showLinkForm && (
              <p className="text-slate-500 text-sm text-center py-4">No link sections configured</p>
            )}
            <div className="space-y-2">
              {linkSections.map(section => (
                <div key={section.title} className="p-3 bg-slate-900/30 rounded-xl border border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setExpandedLinkSection(expandedLinkSection === section.title ? null : section.title)}
                      className="flex items-center gap-2 text-sm font-bold text-white"
                    >
                      {section.title}
                      <FiChevronDown size={14} className={`text-slate-400 transition-transform ${expandedLinkSection === section.title ? 'rotate-180' : ''}`} />
                    </button>
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          const cols = section.columns || {}
                          setEditingLinkSection(section.title)
                          setLinkForm({ title: section.title, columns: { ...cols } })
                          setShowLinkForm(true)
                        }}
                        className="p-1.5 hover:bg-emerald-500/20 text-emerald-400 rounded-lg"
                      >
                        <FiEdit2 size={14} />
                      </button>
                      <button
                        onClick={() => handleDeleteLinkSection(section.title)}
                        className="p-1.5 hover:bg-rose-500/20 text-rose-400 rounded-lg"
                      >
                        <FiTrash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {expandedLinkSection === section.title && (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      {Object.entries(section.columns || {}).map(([key, items]) => (
                        items.length > 0 && (
                          <div key={key}>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{key}</div>
                            <div className="space-y-1">
                              {items.map((item, i) => (
                                <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-800/60 rounded-lg border border-slate-700/50">
                                  <FiExternalLink size={10} className="text-emerald-400 flex-shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-xs text-white truncate">{item.label}</div>
                                    <div className="text-[10px] text-slate-500 truncate">{item.url}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
      {activeTab === "pricing" && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card>
            <SectionHeader title="Plans" icon={FiTag} onAdd={() => { setShowPlanForm(!showPlanForm); setEditingPlan(null); setPlanForm({ plan_name: "", traffic_gb: 10, price_usd: 5 }); }} />
            {showPlanForm && (
              <form onSubmit={handlePlanSubmit} className="mb-6 p-4 bg-slate-900/50 rounded-xl border border-slate-700 animate-in zoom-in-95 duration-200">
                <Input label="Plan Name" value={planForm.plan_name} onChange={e => setPlanForm({...planForm, plan_name: e.target.value})} required disabled={!!editingPlan} />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Traffic (GB)" type="number" value={planForm.traffic_gb} onChange={e => setPlanForm({...planForm, traffic_gb: parseFloat(e.target.value)})} required />
                  <Input label="Price ($)" type="number" value={planForm.price_usd} onChange={e => setPlanForm({...planForm, price_usd: parseFloat(e.target.value)})} required />
                </div>
                <div className="flex gap-2 mt-3">
                  <Button type="submit" className="flex-1">{editingPlan ? "Update" : "Create"} Plan</Button>
                  <Button type="button" variant="outline" onClick={() => setShowPlanForm(false)}>Cancel</Button>
                </div>
              </form>
            )}
            <div className="space-y-2">
              {plans.map(p => (
                <div key={p.plan_name} className="p-3 bg-slate-900/30 rounded-xl border border-slate-700/50 flex items-center justify-between group">
                  <div>
                    <div className="text-sm font-bold text-white">{p.plan_name}</div>
                    <div className="text-[10px] text-slate-500">{p.traffic_gb} GB | ${p.price_usd}</div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setEditingPlan(p.plan_name); setPlanForm({ plan_name: p.plan_name, traffic_gb: p.traffic_gb, price_usd: p.price_usd }); setShowPlanForm(true); }} className="p-1.5 hover:bg-emerald-500/20 text-emerald-400 rounded-lg"><FiEdit2 size={14} /></button>
                    <button onClick={() => deletePlan(p.plan_name)} className="p-1.5 hover:bg-rose-500/20 text-rose-400 rounded-lg"><FiTrash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionHeader title="Discounts" icon={FiTag} onAdd={() => { setShowDiscountForm(!showDiscountForm); setEditingDiscount(null); setDiscountForm({ code: "", discount_percent: 10, max_uses: "" }); }} />
            {showDiscountForm && (
              <form onSubmit={handleDiscountSubmit} className="mb-6 p-4 bg-slate-900/50 rounded-xl border border-slate-700 animate-in zoom-in-95 duration-200">
                <Input label="Code" value={discountForm.code} onChange={e => setDiscountForm({...discountForm, code: e.target.value})} required disabled={!!editingDiscount} />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Percent (%)" type="number" value={discountForm.discount_percent} onChange={e => setDiscountForm({...discountForm, discount_percent: parseFloat(e.target.value)})} required />
                  <Input label="Max Uses (blank = unlimited)" type="number" value={discountForm.max_uses} onChange={e => setDiscountForm({...discountForm, max_uses: e.target.value})} min={1} placeholder="∞" />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" className="flex-1">{editingDiscount ? "Update" : "Create"} Discount</Button>
                  <Button type="button" variant="outline" onClick={() => setShowDiscountForm(false)}>Cancel</Button>
                </div>
              </form>
            )}
            <div className="space-y-2">
              {discounts.map(d => (
                <div key={d.code} className="p-3 bg-slate-900/30 rounded-xl border border-slate-700/50 flex items-center justify-between group">
                  <div>
                    <div className="text-sm font-bold text-white">{d.code}</div>
                    <div className="text-[10px] text-slate-500">
                      {d.discount_percent}% Off
                      {d.max_uses != null
                        ? ` · ${d.used_by?.length || 0}/${d.max_uses} uses`
                        : d.used_by?.length > 0 ? ` · ${d.used_by.length} uses` : ''}
                    </div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setEditingDiscount(d.code); setDiscountForm({ ...d, max_uses: d.max_uses ?? "" }); setShowDiscountForm(true); }} className="p-1.5 hover:bg-emerald-500/20 text-emerald-400 rounded-lg"><FiEdit2 size={14} /></button>
                    <button onClick={() => deleteDiscount(d.code)} className="p-1.5 hover:bg-rose-500/20 text-rose-400 rounded-lg"><FiTrash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionHeader title="Referral Percentages" icon={FiTag} />
            <p className="text-xs text-slate-500 mb-4">Set the bonus percentage for each referral layer. Layer 1 = direct referrer, Layer 5 = deepest level.</p>
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map(layer => (
                <div key={layer} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-16 flex-shrink-0">Layer {layer}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={referralSettings[`layer_${layer}`] ?? 0}
                    onChange={e => setReferralSettings(prev => ({ ...prev, [`layer_${layer}`]: parseFloat(e.target.value) || 0 }))}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-slate-500 w-4">%</span>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Button onClick={handleSaveReferralSettings} disabled={savingReferral} className="w-full">
                {savingReferral ? "Saving…" : "Save Referral Settings"}
              </Button>
            </div>
          </Card>

          <Card>
            <SectionHeader title="Free Trial" icon={FiTag} />
            <p className="text-xs text-slate-500 mb-4">Set the amount of free traffic (GB) new users receive on their first visit.</p>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 w-16 flex-shrink-0">Traffic</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={freeTrialSettings.traffic_gb ?? 0}
                onChange={e => setFreeTrialSettings(prev => ({ ...prev, traffic_gb: parseFloat(e.target.value) || 0 }))}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-slate-500 w-8">GB</span>
            </div>
            <div className="mt-4 space-y-2">
              <Button onClick={handleSaveFreeTrialSettings} disabled={savingFreeTrial} className="w-full">
                {savingFreeTrial ? "Saving…" : "Save Free Trial Settings"}
              </Button>
              <Button onClick={handleGrantFreeTrial} disabled={grantingFreeTrial} variant="outline" className="w-full">
                {grantingFreeTrial ? "Granting…" : "Grant Free Trial to All Users"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
