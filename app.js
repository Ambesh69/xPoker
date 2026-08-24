import { compatibleWallets, connectAndSign, createWalletRegistry, legacyWallets } from "./wallet-standard.js";

const ASSET_STYLE = {
  AAPLx: ["AA", "#dfe5e0", "+0.8%"], NVDAx: ["NV", "#c9f6a5", "+2.4%"],
  MSFTx: ["MS", "#ccecff", "+0.5%"], AMZNx: ["AZ", "#ffd9a2", "+1.2%"],
  GOOGLx: ["GO", "#ffeaa4", "+0.4%"], METAx: ["ME", "#d8dcff", "+1.8%"],
  TSLAx: ["TS", "#ffc7c5", "−0.6%"], NFLXx: ["NF", "#f6c9dc", "+0.7%"],
  SPYx: ["SP", "#d7ff86", "+0.6%"], QQQx: ["QQ", "#ddd5ff", "+0.9%"],
};

const FALLBACK_ASSETS = [
  ["AAPLx", "Apple", 231.42], ["NVDAx", "NVIDIA", 182.19], ["MSFTx", "Microsoft", 516.73],
  ["AMZNx", "Amazon", 218.64], ["GOOGLx", "Alphabet", 201.88], ["METAx", "Meta", 742.06],
  ["TSLAx", "Tesla", 338.11], ["NFLXx", "Netflix", 1194.7], ["SPYx", "S&P 500 ETF", 648.23],
  ["QQQx", "Nasdaq 100 ETF", 576.91],
].map(([symbol, name, indicativePrice]) => ({ symbol, name, indicativePrice }));

const PUBLIC_IDS = [
  "10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004",
];

const baseRules = (game) => ({ game, seats: 6, smallBlindAtomic: "10", bigBlindAtomic: "20", minimumBuyInAtomic: "2000", maximumBuyInAtomic: "10000", rakeBps: 500, rakeCapAtomic: "300", actionClockMs: 20_000, timeBankMs: 60_000 });
const FALLBACK_ROOMS = [
  [PUBLIC_IDS[0], "Opening Bell", "NLH", 5, "Fast six-max no-limit hold'em"],
  [PUBLIC_IDS[1], "Four Cards", "PLO4", 4, "Four-card pot-limit Omaha"],
  [PUBLIC_IDS[2], "Rotation A", "ROE", 6, "One orbit NLH, one orbit PLO 4"],
  [PUBLIC_IDS[3], "Rotation B", "ROE", 3, "Round-of-each with a second public lineup"],
].map(([id, name, game, seatsTaken, description]) => ({ id, name, description, visibility: "public", game, seatsTaken, rules: baseRules(game) }));

const configuredApi = document.querySelector('meta[name="xpoker-api-origin"]')?.content?.trim();
const API_ORIGIN = (configuredApi || localStorage.getItem("xpoker-api-origin") || (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://127.0.0.1:8787" : "")).replace(/\/$/, "");
const SESSION_KEY = "xpoker-safe-beta-session";
const SESSION_META_KEY = "xpoker-safe-beta-session-meta";
const LAST_WALLET_KEY = "xpoker-last-wallet";
const walletRegistry = createWalletRegistry(window);
const PRIVY_WALLETS = Object.freeze([
  {
    id: "phantom",
    name: "Phantom",
    icon: "https://explorer-api.walletconnect.com/v3/logo/sm/b6ec7b81-bb4f-427d-e290-7631e6e50d00?projectId=34357d3c125c2bcf2ce2bc3309d98715",
  },
  {
    id: "solflare",
    name: "Solflare",
    icon: "https://explorer-api.walletconnect.com/v3/logo/sm/34c0e38d-66c4-470e-1aed-a6fabe2d1e00?projectId=34357d3c125c2bcf2ce2bc3309d98715",
  },
  {
    id: "backpack",
    name: "Backpack",
    icon: "https://explorer-api.walletconnect.com/v3/logo/sm/71ca9daf-a31e-4d2a-fd01-f5dc2dc66900?projectId=34357d3c125c2bcf2ce2bc3309d98715",
  },
  { id: "wallet_connect", name: "More Solana wallets", icon: "walletconnect" },
]);
let privyLoad;

function ensurePrivy() {
  if (!privyLoad) {
    privyLoad = import("./privy-bridge.jsx").catch((error) => {
      state.privyReady = false;
      privyLoad = null;
      throw error;
    });
  }
  return privyLoad;
}

function storedJson(storage, key) { try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; } }
const state = {
  view: "lobby", loading: true, backend: API_ORIGIN ? "connecting" : "preview",
  assets: FALLBACK_ASSETS, rooms: FALLBACK_ROOMS, profile: null, token: sessionStorage.getItem(SESSION_KEY),
  selectedRoom: FALLBACK_ROOMS[0], selectedAsset: FALLBACK_ASSETS[0], buyInAmount: 20, hostGame: "NLH",
  tableId: null, tableState: null, tableConnection: "offline", socket: null, reconnectTimer: null,
  reconnectAttempt: 0, holeKey: null, holeHandId: null, holeCards: [], holeDeliverySequence: 0, lastEvent: null, pendingAfterConnect: null, audit: null,
  tableVisual: { handId: null, boardCount: 0, holeCount: 0, potAtomic: 0, phase: null },
  lastHandPresentation: null, presentationTimer: null, pendingTableAction: null,
  leaveRequestId: null,
  handHistory: [], historyError: null, operations: null, operationsPlayers: [], operationsReports: [], operationsInvites: [],
  wallets: [], pendingAccessInvite: "", sessionMeta: storedJson(sessionStorage, SESSION_META_KEY), sessionRecovery: null,
  walletEntryMode: "wallet", privyReady: Boolean(window.xPokerPrivy?.ready), privyBusy: false,
  holdings: { status: "idle", data: null, error: null }, networkOnline: navigator.onLine,
  reconnectNextAt: null, reconnectReason: null, lastConnectedAt: null, proofDownload: null,
};

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function moneyAtomic(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0) / 100); }
function money(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }
function shortWallet(value) { return !value ? "Not connected" : value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value; }
function assetDetails(asset) { const [short, color, move] = ASSET_STYLE[asset.symbol] || [asset.symbol.slice(0, 2), "#dfe5e0", "Demo"]; return { ...asset, short, color, move, price: asset.indicativePrice || asset.price || 1 }; }
function assetLogo(asset) { const item = assetDetails(asset); return `<span class="asset-logo" style="--asset-color:${item.color}" title="${escapeHtml(item.name)}">${escapeHtml(item.short)}</span>`; }
function roomLimits(room) { return { min: Number(room.rules.minimumBuyInAtomic) / 100, max: Number(room.rules.maximumBuyInAtomic) / 100, small: Number(room.rules.smallBlindAtomic) / 100, big: Number(room.rules.bigBlindAtomic) / 100 }; }
function gameLabel(game) { return game === "PLO4" ? "PLO 4" : game === "ROE" ? "NLH ↔ PLO 4" : game; }

function apiHeaders(authenticated = false, supplied = {}) { const headers = { "content-type": "application/json", ...supplied }; if (authenticated && state.token) headers.authorization = `Bearer ${state.token}`; return headers; }
async function api(path, { method = "GET", body, authenticated = false, headers = {} } = {}) {
  if (!API_ORIGIN) throw new Error("The authoritative beta server is not configured on this deployment.");
  const response = await fetch(`${API_ORIGIN}${path}`, { method, headers: apiHeaders(authenticated, headers), body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    if (authenticated && response.status === 401) clearLocalSession("expired");
    throw error;
  }
  return payload;
}

function clearLocalSession(reason = null) {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_META_KEY);
  state.token = null;
  state.profile = null;
  state.sessionMeta = null;
  state.sessionRecovery = reason;
  state.holdings = { status: "idle", data: null, error: null };
}

function storeSession(result, walletName, wallet) {
  const meta = { walletName, wallet, issuedAt: result.issuedAt || new Date().toISOString(), expiresAt: result.expiresAt || null };
  state.token = result.token;
  state.sessionMeta = meta;
  state.sessionRecovery = null;
  sessionStorage.setItem(SESSION_KEY, result.token);
  sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(meta));
  if (walletName) localStorage.setItem(LAST_WALLET_KEY, walletName);
}

function normalizeLobby(payload) {
  state.assets = (payload.assets?.length ? payload.assets : FALLBACK_ASSETS).map((asset) => ({ ...asset, indicativePrice: asset.indicativePrice || asset.price }));
  state.rooms = payload.rooms?.length ? payload.rooms : FALLBACK_ROOMS;
  state.profile = payload.profile || null;
  state.selectedAsset = state.assets.find((asset) => asset.symbol === state.selectedAsset?.symbol) || state.assets[0];
  state.selectedRoom = state.rooms.find((room) => room.id === state.selectedRoom?.id) || state.rooms[0];
}

async function loadLobby({ quiet = false } = {}) {
  if (!quiet) state.loading = true;
  if (API_ORIGIN) {
    try {
      const payload = await api("/v1/beta/lobby", { authenticated: Boolean(state.token) });
      if (state.token && !payload.profile) clearLocalSession("expired");
      normalizeLobby(payload);
      state.backend = "online";
    }
    catch { state.backend = "unavailable"; if (!quiet) toast("Safe-beta server unavailable. Showing interface preview."); normalizeLobby({}); }
  } else { state.backend = "preview"; normalizeLobby({}); }
  state.loading = false; render();
}

function navItem(icon, label, action, active = false) { return `<button class="nav-item ${active ? "active" : ""}" data-action="${action}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`; }
function sidebar() { const authenticated = Boolean(state.profile); return `<aside class="sidebar"><a class="brand" href="#" data-action="go-lobby" aria-label="xPoker home"><span class="brand-mark">xP</span><span class="brand-word">xPoker</span></a><div class="nav-label">Game floor</div><nav class="nav-list" aria-label="Primary navigation">${navItem("⌁", "Tables", "go-lobby", state.view === "lobby")}${navItem("＋", "Host room", "open-host")}${navItem("#", "Join room", "open-invite")}${authenticated ? navItem("◎", "Player profile", "show-profile", state.view === "profile") : ""}${authenticated ? navItem("≋", "Hand history", "show-history", state.view === "history") : ""}</nav>${state.profile?.operatorRole ? `<div class="nav-label">Operations</div><nav class="nav-list" aria-label="Operations navigation">${navItem("⌗", "Pit board", "show-operations", state.view === "operations")}</nav>` : ""}<div class="sidebar-card"><div class="mini-row"><span class="utility-label">Runtime</span><span class="status-pill"><i class="market-dot"></i>${state.backend === "online" ? "Authoritative" : "Preview"}</span></div><strong>Proof before the pot.</strong><p>Table actions are versioned and replayable. Beta credits cannot be deposited, withdrawn, or settled onchain.</p></div></aside>`; }
function topbar() { const wallet = state.profile?.wallet; const labels = { lobby: "Safe multiplayer beta", profile: "Player profile", history: "Hand history", operations: "Pit board" }; return `<header class="topbar"><div class="crumbs"><span>${state.view === "operations" ? "Operations" : "Game floor"}</span><span>／</span><strong>${labels[state.view] || "Safe multiplayer beta"}</strong></div><div class="top-actions"><span class="quote-status"><i class="market-dot"></i>${state.backend === "online" ? "Live beta · demo credits" : "Interface preview · no server"}</span><button class="btn btn-ghost btn-small" data-action="open-buy">Get xStocks</button><button class="btn ${wallet ? "" : "btn-primary"} wallet-btn" data-action="open-wallet">${wallet ? `<span class="wallet-avatar avatar-${escapeHtml(state.profile.avatarStyle || "felt")}">${state.profile.isGuest ? "D" : "W"}</span>${escapeHtml(shortWallet(wallet))}` : "Connect / enter beta"}</button></div></header>`; }

function marketRail() { return `<section class="market-rail" aria-label="Eligible table denominations"><div class="rail-intro"><strong>Core 10</strong><span>Demo denominations</span></div><div class="asset-strip">${state.assets.map((asset) => { const item = assetDetails(asset); return `<button class="asset-quote" data-action="asset-info" data-symbol="${item.symbol}" aria-label="View ${escapeHtml(item.name)}">${assetLogo(item)}<span class="asset-meta"><strong>${item.symbol}</strong><small>${item.move}</small></span></button>`; }).join("")}</div></section>`; }
function roomCard(room, index) { const limits = roomLimits(room); const accents = ["#d7ff86", "#ccecff", "#ddd5ff", "#ffc7c5"]; const seats = room.rules.seats; return `<article class="room-card" style="--room-accent:${accents[index % accents.length]}" data-action="open-buyin" data-room="${room.id}" tabindex="0" aria-label="Join ${escapeHtml(room.name)}"><div class="room-top"><span class="game-pill">${gameLabel(room.game)}</span><span class="status-pill"><i class="market-dot"></i>${state.backend === "online" ? "Live" : "Preview"}</span></div><h3>${escapeHtml(room.name)}</h3><span class="blinds">${money(limits.small)} / ${money(limits.big)} · ${seats} max</span><div class="room-stats"><div class="room-stat"><span>Demo buy-in</span><strong>${money(limits.min)}–${money(limits.max)}</strong></div><div class="room-stat"><span>Rake model</span><strong>${(Number(room.rules.rakeBps) / 100).toFixed(1)}%</strong></div></div><div class="room-footer"><div class="avatar-stack">${Array.from({ length: Math.min(Number(room.seatsTaken || 0), 4) }, (_, seat) => `<span class="avatar" style="--avatar-color:${accents[(seat + index + 1) % accents.length]}">${["LM", "AK", "RZ", "JS"][seat]}</span>`).join("")}</div><span class="seat-count">${Number(room.seatsTaken || 0)}/${seats} seated →</span></div></article>`; }

function privatePanel() {
  const privateRooms = state.rooms.filter((room) => room.visibility === "private");
  return `<section class="private-panel"><div class="section-head"><div><h2>Your private rooms</h2><p>Membership is stored server-side; invite codes are hashed.</p></div><div class="inline-actions"><button class="btn btn-small" data-action="open-invite">Join code</button><button class="btn btn-small" data-action="open-host">＋ New room</button></div></div><div class="private-list">${privateRooms.length ? privateRooms.map((room, index) => { const limits = roomLimits(room); return `<div class="private-room"><span class="private-icon" style="background:${index % 2 ? "#ccecff" : "#ddd5ff"}">${room.game === "PLO4" ? "4c" : room.game === "ROE" ? "↻" : "2c"}</span><span class="private-copy"><strong>${escapeHtml(room.name)}</strong><span>${gameLabel(room.game)} · ${money(limits.small)} / ${money(limits.big)} · ${room.seatsTaken || 0}/${room.rules.seats} seated</span></span><button class="btn btn-small" data-action="open-buyin" data-room="${room.id}">Open</button></div>`; }).join("") : `<div class="panel-empty"><strong>No private rooms yet.</strong><span>Create one or join with an invite code.</span></div>`}</div></section>`;
}

function bankrollPanel() { const credits = state.profile ? moneyAtomic(state.profile.demoCreditAtomic) : "$0.00"; const detected = state.holdings.data?.detectedCount || 0; return `<aside class="bankroll-panel" id="bankroll"><div class="bankroll-head"><span class="utility-label">Non-withdrawable balance</span><div class="balance">${credits}</div><span class="balance-note">Simulated credits · no monetary value</span></div><div class="bankroll-body">${state.profile ? `<div class="holding">${assetLogo(state.selectedAsset)}<span><strong>SAFE BETA</strong><span>${escapeHtml(state.profile.displayName)}</span></span><span class="holding-value"><strong>${state.profile.isGuest ? "Guest" : "Wallet"}</strong><span>${escapeHtml(shortWallet(state.profile.wallet))}</span></span></div>${state.profile.isGuest ? "" : `<button class="holdings-glance" data-action="open-wallet"><span>Core 10 scan</span><strong>${state.holdings.status === "loading" ? "Reading…" : state.holdings.status === "error" ? "Unavailable" : state.holdings.status === "ready" ? `${detected} detected` : "Ready to read"}</strong><small>Public balance lookup · never used for seating</small></button>`}<div class="safety-list"><span>✓ Cannot deposit</span><span>✓ Cannot withdraw</span><span>✓ Cannot settle onchain</span></div><div class="bankroll-actions"><button class="btn btn-small" data-action="open-wallet">Session receipt</button><button class="btn btn-small btn-accent" data-action="quick-seat">Find seat</button></div>` : `<div class="empty-balance"><span class="empty-orbit">0 USD</span><strong>Enter without risking funds.</strong><p>Sign with a Solana wallet, or create an expiring guest identity to test multiplayer.</p><button class="btn btn-primary" data-action="open-wallet">Enter safe beta</button></div>`}</div></aside>`; }

function lobbyView() { return `<div class="app-shell">${sidebar()}<main class="page">${topbar()}<div class="content"><section class="hero"><div><span class="eyebrow">Authoritative multiplayer · zero-value beta</span><h1>Play the <em>market.</em></h1><p class="hero-copy">Choose an xStock denomination, take a seat with simulated credits, and test real wallet authentication, live table events, and reconnects. No token approval is requested and no funds can move.</p></div><div class="hero-actions"><button class="btn btn-primary" data-action="quick-seat">Find a beta seat</button><button class="btn" data-action="open-host">Host private room</button></div></section><div class="beta-boundary"><span class="boundary-mark">β</span><div><strong>Safe boundary</strong><span>xStock names set the table denomination only. Balances, pots, and rake below are simulated accounting.</span></div><span class="boundary-state">FUNDS MOVE: NO</span></div>${marketRail()}<section><div class="section-head"><div><h2>The public floor</h2><p>Four permanent rooms. Every seat starts from $20 in demo credits.</p></div><span class="tag">NLH · PLO 4 · ROE</span></div><div class="public-grid">${state.rooms.filter((room) => room.visibility === "public").map(roomCard).join("")}</div></section><div class="dashboard-row">${privatePanel()}${bankrollPanel()}</div></div></main></div>`; }

function pageShell(body) { return `<div class="app-shell">${sidebar()}<main class="page">${topbar()}<div class="content operations-content">${body}</div></main></div>`; }
function dateTime(value) { if (!value) return "—"; return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function profileView() {
  const profile = state.profile;
  if (!profile) return lobbyView();
  return pageShell(`<section class="subpage-hero"><div><span class="eyebrow">Your seat identity</span><h1>Known at every <em>table.</em></h1><p>One profile follows your signed wallet or expiring guest identity. It never holds funds or token permissions.</p></div><span class="profile-orbit avatar-${escapeHtml(profile.avatarStyle || "felt")}">${escapeHtml(profile.displayName.slice(0, 2).toUpperCase())}</span></section><div class="profile-layout"><form class="paper-panel profile-form" id="profile-form"><div class="section-head"><div><h2>Table card</h2><p>Visible to players who share a table with you.</p></div><span class="status-pill ${profile.status !== "active" ? "status-alert" : ""}">${escapeHtml(profile.status || "active")}</span></div><label class="field"><span class="field-label">Display name</span><input class="input" name="displayName" maxlength="24" value="${escapeHtml(profile.displayName)}" required /></label><label class="field"><span class="field-label">Short bio</span><textarea class="input textarea" name="bio" maxlength="160" placeholder="How you like to play">${escapeHtml(profile.bio || "")}</textarea></label><div class="field"><span class="field-label">Card back</span><div class="avatar-choices">${["felt", "river", "ticker", "night"].map((style) => `<label class="avatar-choice avatar-${style}"><input type="radio" name="avatarStyle" value="${style}" ${style === (profile.avatarStyle || "felt") ? "checked" : ""}/><span>${style.slice(0, 2).toUpperCase()}</span><small>${style}</small></label>`).join("")}</div></div><button class="btn btn-primary" type="button" data-action="save-profile">Save profile</button></form><aside class="paper-panel access-panel"><span class="utility-label">Closed-beta access</span><h2>${profile.betaAccessGrantedAt ? "Invitation accepted" : "Access code ready"}</h2><p>${profile.betaAccessGrantedAt ? `Granted ${dateTime(profile.betaAccessGrantedAt)}. Your access stays bound to this identity.` : "If the beta becomes invite-only, redeem a code here before taking a seat."}</p><label class="field"><span class="field-label">Beta invitation</span><input class="input" id="beta-invite-code" maxlength="20" placeholder="BETA-XXXXX-XXXXX" autocomplete="off" /></label><button class="btn" data-action="redeem-beta-invite">Redeem access</button><div class="profile-ledger"><span><small>Identity</small><strong>${profile.isGuest ? "Guest" : "Wallet"}</strong></span><span><small>Created</small><strong>${dateTime(profile.createdAt)}</strong></span><span><small>Role</small><strong>${escapeHtml(profile.operatorRole || "Player")}</strong></span></div></aside></div>`);
}

function historyPayout(hand) { const payout = hand.result?.payouts?.find((entry) => entry.playerId === state.profile?.wallet); return payout ? moneyAtomic(payout.amountAtomic) : hand.status === "complete" ? "$0.00" : "Pending"; }
function handHistoryView() {
  const hands = state.handHistory;
  const loadError = state.historyError ? `<div class="history-load-error" role="alert"><div><strong>Hand archive temporarily unavailable.</strong><span>Your records have not been removed. The archive service did not answer in time.</span></div><button class="btn btn-small" data-action="refresh-history">Try again</button></div>` : "";
  const content = hands.length
    ? hands.map((hand) => `<article class="history-row"><div><strong>#${escapeHtml(hand.handId.split(":").at(-1))} · ${escapeHtml(hand.roomName)}</strong><span>${dateTime(hand.startedAt)} · ${hand.players.length} players</span></div><div><strong>${escapeHtml(gameLabel(hand.game))}</strong><span>drand ${hand.beaconRound || "pending"}</span></div><div><strong>${historyPayout(hand)}</strong><span>Rake ${hand.result ? moneyAtomic(hand.result.rakeAtomic) : "—"}</span></div><div class="history-actions">${hand.auditAvailable ? `<button class="btn btn-small" data-action="view-audit" data-hand="${escapeHtml(hand.handId)}">Verify</button><button class="btn btn-small" data-action="download-audit" data-hand="${escapeHtml(hand.handId)}">Save proof</button>` : `<span class="status-pill">${escapeHtml(hand.status)}</span>`}<button class="btn btn-small btn-ghost" data-action="open-report" data-hand="${escapeHtml(hand.handId)}">Report</button></div></article>`).join("")
    : state.historyError
      ? `<div class="panel-empty roomy history-error-empty"><strong>We could not load your hands.</strong><span>Retry the archive; do not play another hand to replace these records.</span><button class="btn" data-action="refresh-history">Retry archive</button></div>`
      : `<div class="panel-empty roomy"><strong>No hands on tape yet.</strong><span>Finish a safe-beta hand and its signed record will appear here.</span><button class="btn btn-accent" data-action="go-lobby">Find a table</button></div>`;
  return pageShell(`<section class="subpage-hero compact-hero"><div><span class="eyebrow">Signed hand archive</span><h1>Your hand <em>tape.</em></h1><p>Completed hands retain their external randomness round, committed deck root, outcome, and portable reconstruction proof.</p></div><button class="btn" data-action="refresh-history">Refresh history</button></section><section class="paper-panel history-panel"><div class="proof-guide"><span class="proof-guide-mark">JSON</span><div><strong>Every completed hand has a portable proof.</strong><small>Verify it in xPoker, or download the complete bundle for independent retention.</small></div><span>Deck root · drand · seeds · reveals · transcript</span></div>${loadError}<div class="history-head"><span>Hand</span><span>Game</span><span>Result</span><span>Proof</span></div>${content}</section>`);
}

function pulseRail(operations) { const summary = operations?.summary || {}; const instances = operations?.instances || []; const monitor = operations?.monitoring; const healthy = monitor?.status === "healthy"; const headline = !healthy ? "Operational attention required" : instances.length >= 2 ? "Monitored and redundant" : instances.length ? "Monitored on one instance" : "Awaiting heartbeat"; return `<section class="pulse-rail ${healthy ? "" : "pulse-alert"}"><div class="pulse-lead"><span class="pulse-mark"></span><div><span class="utility-label">Table pulse</span><strong>${headline}</strong></div></div><div class="pulse-segment"><small>API instances</small><strong>${instances.length}</strong></div><div class="pulse-segment"><small>Active tables</small><strong>${summary.activeTables || 0}</strong></div><div class="pulse-segment"><small>Error rate</small><strong>${((summary.errorRate || 0) * 100).toFixed(2)}%</strong></div><div class="pulse-instances">${instances.map((instance) => `<span title="${escapeHtml(instance.instanceId)}"><i></i>${escapeHtml(String(instance.buildCommit).slice(0, 7))}</span>`).join("") || "No heartbeat"}</div></section>`; }
function monitoringPanel(operations) { const monitor = operations?.monitoring; if (!monitor) return `<section class="monitor-panel monitor-warning"><div><span class="utility-label">Automated probes</span><strong>Monitoring unavailable</strong></div></section>`; const checks = Object.entries(monitor.checks || {}); const gauges = monitor.gauges || {}; return `<section class="monitor-panel ${monitor.status === "healthy" ? "" : "monitor-warning"}"><div class="monitor-copy"><span class="utility-label">Automated probes · ${dateTime(monitor.checkedAt)}</span><strong>${monitor.status === "healthy" ? "All operational checks healthy" : `${monitor.failed?.length || 0} checks need attention`}</strong><small>Postgres ${Math.round(gauges.postgres_latency_ms || 0)} ms · Redis ${Math.round(gauges.redis_latency_ms || 0)} ms · ${monitor.activeRealtimeConnections || 0} realtime clients · ${Math.round(gauges.overdue_action_deadlines || 0)} overdue clocks</small></div><div class="monitor-checks">${checks.map(([name, status]) => `<span class="monitor-check ${status === "healthy" ? "" : "monitor-check-failed"}"><i></i>${escapeHtml(name.replaceAll("_", " "))}</span>`).join("") || `<span class="monitor-check monitor-check-failed"><i></i>Awaiting first probe</span>`}</div></section>`; }
function operationsView() {
  if (!state.profile?.operatorRole) return lobbyView();
  const ops = state.operations || { summary: {}, reports: [], incidents: [], instances: [] }; const summary = ops.summary || {};
  return pageShell(`<section class="subpage-hero compact-hero"><div><span class="eyebrow">Operator-only control surface</span><h1>The pit <em>board.</em></h1><p>Live service pulse, moderation queue, invitations, and player controls. Every operator action is append-only.</p></div><div class="hero-actions"><span class="tag">${escapeHtml(state.profile.operatorRole)}</span><button class="btn" data-action="refresh-operations">Refresh</button></div></section>${pulseRail(ops)}${monitoringPanel(ops)}<section class="ops-metrics">${[["Players", summary.players || 0, `${summary.activePlayers || 0} active today`],["Hands / 24h", summary.hands24h || 0, "signed completions"],["Reports", summary.openReports || 0, "awaiting review"],["Incidents", summary.openIncidents || 0, `${Math.round(summary.averageLatencyMs || 0)} ms average`]].map(([label,value,note]) => `<div class="metric-card"><span class="utility-label">${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("")}</section><div class="ops-grid"><section class="paper-panel queue-panel"><div class="section-head"><div><h2>Moderation queue</h2><p>Oldest unresolved player reports first.</p></div><span class="tag">${ops.reports?.length || 0} shown</span></div><div class="queue-list">${ops.reports?.length ? ops.reports.map((report) => `<article class="queue-item"><span class="severity severity-${escapeHtml(report.category)}">${escapeHtml(report.category)}</span><div><strong>${escapeHtml(report.details)}</strong><span>${dateTime(report.createdAt)} · ${escapeHtml(shortWallet(report.reporterWallet))}${report.handId ? ` · hand #${escapeHtml(report.handId.split(":").at(-1))}` : ""}</span></div><div class="queue-actions"><button class="btn btn-small" data-action="moderate-report" data-id="${report.id}" data-status="reviewing">Claim</button><button class="btn btn-small btn-primary" data-action="moderate-report" data-id="${report.id}" data-status="resolved">Resolve</button></div></article>`).join("") : `<div class="panel-empty"><strong>Queue clear.</strong><span>No open player reports.</span></div>`}</div></section><section class="paper-panel queue-panel"><div class="section-head"><div><h2>Runtime incidents</h2><p>Deduplicated application errors, with secrets redacted.</p></div></div><div class="queue-list">${ops.incidents?.length ? ops.incidents.map((incident) => `<article class="queue-item"><span class="severity severity-${escapeHtml(incident.severity)}">${escapeHtml(incident.severity)}</span><div><strong>${escapeHtml(incident.message)}</strong><span>${escapeHtml(incident.category)} · ${incident.occurrences}× · ${dateTime(incident.lastSeenAt)}</span></div>${state.profile.operatorRole === "admin" ? `<button class="btn btn-small" data-action="resolve-incident" data-id="${incident.id}">Resolve</button>` : ""}</article>`).join("") : `<div class="panel-empty"><strong>No open incidents.</strong><span>The runtime has not recorded an application failure.</span></div>`}</div></section></div><div class="ops-grid lower-ops"><section class="paper-panel"><div class="section-head"><div><h2>Players</h2><p>Account state and recent participation.</p></div><span class="tag">${state.operationsPlayers.length} loaded</span></div><div class="player-table">${state.operationsPlayers.slice(0, 20).map((player) => `<div class="player-row"><span class="wallet-avatar avatar-${escapeHtml(player.avatarStyle)}">${escapeHtml(player.displayName.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(player.displayName)}</strong><small>${escapeHtml(shortWallet(player.wallet))}</small></span><span><strong>${player.handsPlayed}</strong><small>hands</small></span><span class="status-pill ${player.status !== "active" ? "status-alert" : ""}">${escapeHtml(player.status)}</span><button class="btn btn-small" data-action="moderate-player" data-wallet="${escapeHtml(player.wallet)}" data-status="${player.status === "active" ? "suspended" : "active"}">${player.status === "active" ? "Suspend" : "Restore"}</button></div>`).join("") || `<div class="panel-empty"><strong>No player records.</strong><span>Profiles appear after beta entry.</span></div>`}</div></section>${state.profile.operatorRole === "admin" ? `<section class="paper-panel invite-console"><div class="section-head"><div><h2>Access invitations</h2><p>Codes are displayed once; only their digest is stored.</p></div></div><form id="operator-invite-form" class="invite-form"><label class="field"><span class="field-label">Cohort label</span><input class="input" name="label" value="Founding table" maxlength="48" required /></label><div class="form-grid tight"><label class="field"><span class="field-label">Uses</span><input class="input" name="maxUses" type="number" min="1" max="100" value="10" /></label><label class="field"><span class="field-label">Hours</span><input class="input" name="expiresHours" type="number" min="1" max="2160" value="168" /></label></div><button type="button" class="btn btn-accent" data-action="create-beta-invite">Create invitation</button></form><div class="invite-ledger">${state.operationsInvites.slice(0, 8).map((invite) => `<div><span><strong>${escapeHtml(invite.label)}</strong><small>${invite.useCount}/${invite.maxUses} used · expires ${dateTime(invite.expiresAt)}</small></span><span class="status-pill">${invite.revokedAt ? "revoked" : "active"}</span></div>`).join("") || `<div class="panel-empty"><strong>No access invitations.</strong><span>Create the first closed-beta cohort.</span></div>`}</div></section>` : ""}</div>`);
}

function modalShell({ eyebrow, title, description = "", body, footer = "", wide = false, kind = "" }) { return `<div class="modal-overlay" data-action="close-modal"><section class="modal ${wide ? "modal-wide" : ""} ${kind}" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header class="modal-head"><div><span class="eyebrow">${eyebrow}</span><h2 id="modal-title">${title}</h2>${description ? `<p>${description}</p>` : ""}</div><button class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-foot">${footer}</footer>` : ""}</section></div>`; }
function openModal(html, { reusePanel = false } = {}) {
  const root = document.querySelector("#modal-root");
  if (reusePanel) {
    const current = root.querySelector(".wallet-modal");
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const next = template.content.querySelector(".wallet-modal");
    if (current && next) {
      const scrollTop = current.scrollTop;
      current.className = next.className;
      current.innerHTML = next.innerHTML;
      current.scrollTop = scrollTop;
      bindEvents(current);
      return;
    }
  }
  root.innerHTML = html;
  document.body.style.overflow = "hidden";
  bindEvents(root);
  setTimeout(() => document.querySelector(".modal button, .modal input")?.focus(), 0);
}
function closeModal() { document.querySelector("#modal-root").innerHTML = ""; document.body.style.overflow = ""; state.walletEntryMode = "wallet"; }

function walletInitials(name) { return String(name || "Wallet").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function walletBrand(name) { const normalized = String(name || "").toLowerCase(); return ["phantom", "solflare", "backpack", "brave", "metamask"].find((brand) => normalized.includes(brand)) || "default"; }
function walletLogo(wallet) {
  const icon = typeof wallet?.icon === "string" && wallet.icon.startsWith("data:image/") ? wallet.icon : "";
  return `<span class="provider-logo wallet-brand-${walletBrand(wallet?.name)}">${icon ? `<img src="${escapeHtml(icon)}" alt="" />` : `<b>${escapeHtml(walletInitials(wallet?.name))}</b>`}</span>`;
}
function phantomBrowseUrl() { const page = encodeURIComponent(location.href); const ref = encodeURIComponent(location.origin); return `https://phantom.app/ul/browse/${page}?ref=${ref}`; }
function detectedHolding(symbol) { return state.holdings.data?.holdings?.find((holding) => holding.symbol === symbol); }
function holdingsReceipt() {
  if (state.profile?.isGuest) return `<div class="receipt-empty"><strong>Guest identity</strong><span>Onchain holdings are available only after a signed wallet login.</span></div>`;
  if (state.holdings.status === "loading" || state.holdings.status === "idle") return `<div class="receipt-empty receipt-loading"><strong>Reading the Core 10…</strong><span>One public Solana account lookup. No wallet prompt or permission.</span></div>`;
  if (state.holdings.status === "error") return `<div class="receipt-empty receipt-warning"><strong>Holdings unavailable</strong><span>${escapeHtml(state.holdings.error || "The read-only source did not respond.")}</span><button class="audit-link" data-action="refresh-holdings">Try again →</button></div>`;
  const detected = state.holdings.data?.holdings?.filter((holding) => holding.detected) || [];
  if (!detected.length) return `<div class="receipt-empty"><strong>No Core 10 xStocks detected</strong><span>The wallet is still eligible for every demo-credit table.</span></div>`;
  return `<div class="receipt-holdings">${detected.map((holding) => `<div>${assetLogo(holding)}<span><strong>${escapeHtml(holding.symbol)}</strong><small>${holding.displayAmount === null ? "Raw balance found · multiplier unavailable" : `${escapeHtml(holding.displayAmount)} shares · read only`}</small></span><span class="receipt-check">Seen</span></div>`).join("")}</div>`;
}
function walletSafetyReceipt() {
  const meta = state.sessionMeta || {};
  const guest = state.profile?.isGuest;
  return `<section class="wallet-receipt"><header><span><small>Wallet safety receipt</small><strong>${guest ? "Guest session" : escapeHtml(meta.walletName || "Solana wallet")}</strong></span><span class="receipt-stamp">READ ONLY</span></header><div class="receipt-permissions"><span><i>✓</i><strong>${guest ? "Created" : "Signed"}</strong><small>${guest ? "Expiring guest identity" : "Domain-bound login message"}</small></span><span><i>0</i><strong>Approvals</strong><small>No token permission requested</small></span><span><i>0</i><strong>Transactions</strong><small>No transfer constructed</small></span></div><div class="receipt-ledger"><span>Wallet</span><strong>${escapeHtml(shortWallet(state.profile?.wallet))}</strong><span>Session expires</span><strong>${meta.expiresAt ? dateTime(meta.expiresAt) : "Automatically"}</strong></div><div class="receipt-divider"><span>Core 10 holdings · informational only</span><button class="audit-link" data-action="refresh-holdings" ${guest ? "disabled" : ""}>Refresh</button></div>${holdingsReceipt()}</section>`;
}
function walletProviderList(serverReady) {
  if (!state.wallets.length) return `<div class="wallet-discovery-empty"><span class="empty-wallet-mark">↗</span><div><strong>No browser wallet detected</strong><span>Install or open a Wallet Standard-compatible Solana wallet, then return here.</span></div></div>`;
  const preferred = localStorage.getItem(LAST_WALLET_KEY);
  const priority = { Phantom: 0, Solflare: 1, Backpack: 2 };
  const wallets = state.wallets.map((wallet, index) => ({ wallet, index })).sort((left, right) => {
    if (left.wallet.name === preferred) return -1;
    if (right.wallet.name === preferred) return 1;
    return (priority[left.wallet.name] ?? 20) - (priority[right.wallet.name] ?? 20) || left.wallet.name.localeCompare(right.wallet.name);
  });
  return `<div class="provider-list">${wallets.map(({ wallet, index }, position) => `<button class="provider ${position === 0 ? "provider-first" : ""}" data-action="connect-provider" data-provider-index="${index}" ${serverReady ? "" : "disabled"}>${walletLogo(wallet)}<span class="provider-copy"><strong>${escapeHtml(wallet.name)}</strong><small>${wallet.name === preferred ? "Last used · one login signature" : "Detected on this device"}</small></span><span class="provider-arrow" aria-hidden="true">↗</span></button>`).join("")}</div>`;
}
function walletInviteField() { return `<details class="wallet-invite" ${state.pendingAccessInvite ? "open" : ""}><summary><span>Have a beta code?</span><small>Optional</small></summary><label class="field"><span class="sr-only">Closed-beta code</span><input class="input invite-code-input" id="access-invite-code" maxlength="20" value="${escapeHtml(state.pendingAccessInvite)}" placeholder="BETA-XXXXX-XXXXX" autocomplete="off" /></label></details>`; }
function privyWalletIcon(wallet) {
  if (wallet.icon !== "walletconnect") return `<span class="wallet-logo-fallback" aria-hidden="true">${escapeHtml(walletInitials(wallet.name))}</span><img src="${escapeHtml(wallet.icon)}" alt="" />`;
  return `<svg viewBox="0 0 300 185" aria-hidden="true"><path d="M61.44 36.26c48.91-47.89 128.21-47.89 177.12 0l5.89 5.76a6.04 6.04 0 0 1 0 8.67l-20.14 19.72a6.35 6.35 0 0 1-8.86 0l-8.1-7.93c-34.12-33.41-89.44-33.41-123.56 0l-8.68 8.49a6.35 6.35 0 0 1-8.86 0L46.12 51.25a6.04 6.04 0 0 1 0-8.67l15.32-6.32Zm218.77 40.77 17.92 17.55a6.04 6.04 0 0 1 0 8.67l-80.81 79.12a6.35 6.35 0 0 1-8.86 0l-57.35-56.16a1.59 1.59 0 0 0-2.22 0l-57.35 56.16a6.35 6.35 0 0 1-8.86 0L1.87 103.25a6.04 6.04 0 0 1 0-8.67l17.92-17.55a6.35 6.35 0 0 1 8.86 0l57.35 56.15a1.59 1.59 0 0 0 2.22 0l57.35-56.15a6.35 6.35 0 0 1 8.86 0l57.35 56.15a1.59 1.59 0 0 0 2.22 0l57.35-56.15a6.35 6.35 0 0 1 8.86 0Z" /></svg>`;
}
function privyWalletDetected(wallet) {
  if (wallet.id === "wallet_connect") return false;
  return state.wallets.some((candidate) => walletBrand(candidate.name) === wallet.id);
}
function privyWalletChoices(privyReady) {
  return `<div class="wallet-choice-grid">${PRIVY_WALLETS.map((wallet) => {
    const detected = privyWalletDetected(wallet);
    const busy = state.privyBusy === wallet.id;
    const waiting = state.backend === "online" && !privyReady;
    const status = busy ? "Check your wallet…" : waiting ? "Loading…" : detected ? "Installed" : wallet.id === "wallet_connect" ? "Compatible options only" : "Open or install";
    return `<button class="wallet-choice wallet-choice-${escapeHtml(wallet.id)}" data-action="connect-privy-wallet" data-wallet-id="${escapeHtml(wallet.id)}" ${privyReady && !state.privyBusy ? "" : "disabled"}><span class="wallet-choice-logo">${privyWalletIcon(wallet)}</span><span class="wallet-choice-copy"><strong>${escapeHtml(wallet.name)}</strong><small class="${detected ? "is-detected" : ""}">${escapeHtml(status)}</small></span><span class="wallet-choice-arrow" aria-hidden="true">${busy ? "···" : "→"}</span></button>`;
  }).join("")}</div>`;
}
function walletEntryBody(serverReady, recovery) {
  if (state.walletEntryMode === "guest") return `<div data-wallet-modal data-wallet-entry class="wallet-entry guest-entry">${recovery}<button class="wallet-back" data-action="show-wallet-login">← Use a wallet instead</button><div class="guest-entry-title"><span>G</span><div><strong>Enter with a guest profile</strong><small>Temporary identity · demo credits only</small></div></div><label class="field"><span class="field-label">Display name</span><input class="input" id="guest-name" maxlength="24" value="Market Player" autocomplete="nickname" /></label>${walletInviteField()}<button class="btn btn-accent guest-submit" data-action="guest-session" ${serverReady ? "" : "disabled"}>Enter beta as guest</button>${serverReady ? "" : `<div class="preview-fallback"><p class="legal-note warning-note">The multiplayer server is unavailable.</p><button class="btn" data-action="preview-session">Open interface preview</button></div>`}</div>`;
  const privyReady = serverReady && state.privyReady;
  return `<div data-wallet-modal data-wallet-entry class="wallet-entry">${recovery}${privyWalletChoices(privyReady)}<div class="wallet-picker-meta"><span><i></i> Secured by Privy</span><span>Solana · SIWS</span></div>${walletInviteField()}<button class="guest-choice" data-action="show-guest-login"><span><strong>Just looking around?</strong><small>Use a temporary guest profile</small></span><b>Continue as guest →</b></button>${serverReady ? "" : `<div class="preview-fallback"><p class="legal-note warning-note">The multiplayer server is unavailable.</p><button class="btn" data-action="preview-session">Open interface preview</button></div>`}</div>`;
}
function walletModal(after = state.pendingAfterConnect) {
  state.pendingAfterConnect = after;
  const priorInvite = document.querySelector("#access-invite-code")?.value;
  if (priorInvite !== undefined) state.pendingAccessInvite = priorInvite;
  const serverReady = state.backend === "online";
  const recovery = state.sessionRecovery === "expired" ? `<div class="recovery-note"><span>↻</span><div><strong>Session expired</strong><small>Reconnect to continue. Your table and wallet were not changed.</small></div></div>` : "";
  const canDo = state.profile?.isGuest ? "Join demo rooms, send poker actions, and resume a table." : "Join demo rooms, send poker actions, resume a table, and read the approved ten public token balances.";
  openModal(modalShell({ kind: "wallet-modal", eyebrow: state.profile ? "Session details" : "Solana sign-in", title: state.profile ? "Your beta session" : state.walletEntryMode === "guest" ? "Play without a wallet" : "Choose your wallet", description: state.profile ? "Your temporary identity and its read-only permissions." : state.walletEntryMode === "guest" ? "Create an expiring profile for the zero-value beta." : "Select the wallet you already use.", body: state.profile ? `<div data-wallet-modal>${walletSafetyReceipt()}<div class="safety-box"><strong>This session can</strong><span>${canDo}</span><strong>This session cannot</strong><span>Spend tokens, approve a program, deposit, withdraw, or cash out.</span></div></div>` : walletEntryBody(serverReady, recovery), footer: state.profile ? `<span class="balance-note">Bearer session stored in this tab only</span><button class="btn" data-action="logout">End session</button>` : `<span class="wallet-foot-signal"><i></i> Identity protected by Privy</span><span class="wallet-foot-boundary">DEMO · NO FUNDS</span>` }), { reusePanel: true });
  if (state.profile && !state.profile.isGuest && state.holdings.status === "idle") loadHoldings();
  if (!state.profile && state.walletEntryMode === "wallet") void ensurePrivy().catch(() => {
    if (document.querySelector("[data-wallet-entry]")) toast("Wallet connections could not load. Try again in a moment.");
  });
}

function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }

async function connectProvider(button) {
  state.pendingAccessInvite = document.querySelector("#access-invite-code")?.value.trim().toUpperCase() || "";
  const wallet = state.wallets[Number(button.dataset.providerIndex)]; const providerName = wallet?.name;
  if (!wallet) { toast("That wallet is no longer available. Reopen the wallet menu."); return; }
  button.disabled = true; button.querySelector("small").textContent = "Signing…";
  try {
    let challenge;
    const signed = await connectAndSign(wallet, async (account) => {
      challenge = await api("/v1/auth/challenge", { method: "POST", body: { wallet: account.address } });
      return challenge.message;
    });
    const walletAddress = signed.account.address;
    const verified = await api("/v1/auth/verify", { method: "POST", body: { id: challenge.id, wallet: walletAddress, signature: bytesToBase64Url(signed.signature) } });
    storeSession(verified, providerName, walletAddress);
    let inviteError;
    if (state.pendingAccessInvite) {
      try { await api("/v1/beta/invitations/redeem", { method: "POST", authenticated: true, body: { code: state.pendingAccessInvite } }); }
      catch (error) { inviteError = error; }
    }
    state.pendingAccessInvite = "";
    closeModal(); await loadLobby({ quiet: true });
    loadHoldings();
    if (inviteError) { toast(`${providerName} verified, but the invitation was not accepted: ${inviteError.message}`); state.view = "profile"; render(); }
    else { toast(`${providerName} ownership verified. No transaction was requested.`); resumePendingAction(); }
  } catch (error) { button.disabled = false; button.querySelector("small").textContent = "Try again"; toast(error.message || "Wallet sign-in failed."); }
}

async function connectPrivy(button) {
  state.pendingAccessInvite = document.querySelector("#access-invite-code")?.value.trim().toUpperCase() || "";
  if (!window.xPokerPrivy?.ready) { toast("Privy is still loading. Try again in a moment."); return; }
  const walletId = button.dataset.walletId;
  const wallet = PRIVY_WALLETS.find((candidate) => candidate.id === walletId);
  if (!wallet) { toast("That wallet option is unavailable."); return; }
  state.privyBusy = walletId;
  button.disabled = true;
  button.querySelector(".wallet-choice-copy small").textContent = `Opening ${wallet.name}…`;
  try {
    const identity = await window.xPokerPrivy.login(walletId);
    const verified = await api("/v1/auth/privy", {
      method: "POST",
      headers: { authorization: `Bearer ${identity.accessToken}` },
      body: { wallet: identity.wallet },
    });
    storeSession(verified, identity.walletName || wallet.name, verified.wallet);
    let inviteError;
    if (state.pendingAccessInvite) {
      try { await api("/v1/beta/invitations/redeem", { method: "POST", authenticated: true, body: { code: state.pendingAccessInvite } }); }
      catch (error) { inviteError = error; }
    }
    state.pendingAccessInvite = "";
    closeModal();
    await loadLobby({ quiet: true });
    loadHoldings();
    if (inviteError) { toast(`${wallet.name} was verified, but the invitation was not accepted: ${inviteError.message}`); state.view = "profile"; render(); }
    else { toast(`${wallet.name} verified. No transaction was requested.`); resumePendingAction(); }
  } catch (error) {
    toast(error.message || "Privy sign-in failed.");
  } finally {
    state.privyBusy = false;
    if (document.querySelector("[data-wallet-entry]")) walletModal();
  }
}

async function loadHoldings() {
  if (!state.profile || state.profile.isGuest || !state.token || state.backend !== "online") return;
  state.holdings = { status: "loading", data: null, error: null };
  if (document.querySelector("[data-wallet-modal]")) walletModal(); else render();
  try {
    const result = await api("/v1/beta/wallet/holdings", { authenticated: true });
    state.holdings = { status: "ready", data: result, error: null };
  } catch (error) {
    state.holdings = { status: "error", data: null, error: error.message };
  }
  if (document.querySelector("[data-wallet-modal]")) walletModal(); else render();
}

async function createGuestSession() {
  const input = document.querySelector("#guest-name"); const button = document.querySelector('[data-action="guest-session"]');
  state.pendingAccessInvite = document.querySelector("#access-invite-code")?.value.trim().toUpperCase() || "";
  button.disabled = true; button.textContent = "Creating…";
  try { const result = await api("/v1/beta/demo-session", { method: "POST", body: { displayName: input.value, inviteCode: state.pendingAccessInvite || undefined } }); storeSession(result, "Guest", result.wallet); state.pendingAccessInvite = ""; closeModal(); await loadLobby({ quiet: true }); toast("Guest session ready. It has no monetary value."); resumePendingAction(); }
  catch (error) { button.disabled = false; button.textContent = "Create guest session"; toast(error.message); }
}

function createPreviewSession() {
  state.profile = {
    wallet: "InterfacePreviewOnly",
    displayName: document.querySelector("#guest-name")?.value || "Market Player",
    isGuest: true,
    demoCreditAtomic: "100000",
  };
  closeModal();
  render();
  toast("Local interface preview opened. Multiplayer is not connected.");
  resumePendingAction();
}

function resumePendingAction() { const pending = state.pendingAfterConnect; state.pendingAfterConnect = null; if (pending === "buyin") buyinModal(state.selectedRoom); if (pending === "host") hostModal(); if (pending === "invite") inviteModal(); if (pending === "table" && state.tableId) { state.view = "table"; render(); connectRealtime(); } }
function assetPicker(selectedSymbol) { return `<div class="asset-picker">${state.assets.map((asset) => `<button class="asset-option ${asset.symbol === selectedSymbol ? "selected" : ""}" data-action="select-asset" data-symbol="${asset.symbol}">${assetLogo(asset)}<strong>${asset.symbol}</strong></button>`).join("")}</div>`; }

function buyinModal(room) {
  state.selectedRoom = room; const limits = roomLimits(room); state.buyInAmount = Math.max(limits.min, Math.min(state.buyInAmount, limits.max)); const asset = assetDetails(state.selectedAsset); const holding = detectedHolding(asset.symbol);
  const holdingNote = !state.profile || state.profile.isGuest ? "No onchain lookup for this identity." : state.holdings.status === "ready" ? holding?.detected ? `${holding.displayAmount ?? "Raw balance"} ${asset.symbol} detected publicly. This does not change your demo stack.` : `No ${asset.symbol} detected. You can still take this demo seat.` : "Open your session receipt to run the optional read-only scan.";
  openModal(modalShell({ eyebrow: `${gameLabel(room.game)} · ${money(limits.small)} / ${money(limits.big)}`, title: `Take a demo seat at ${escapeHtml(room.name)}`, description: `Min ${money(limits.min)} · Max ${money(limits.max)}. This amount is simulated and non-withdrawable.`, body: `<div class="field"><span class="field-label">Choose table denomination</span>${assetPicker(asset.symbol)}</div><div class="field" style="margin-top:18px"><span class="field-label">Demo buy-in</span><input class="range" id="buyin-range" type="range" min="${limits.min}" max="${limits.max}" step="5" value="${state.buyInAmount}" aria-label="Demo buy-in amount" /><div class="quick-amounts"><button class="btn btn-small" data-action="set-buyin" data-value="${limits.min}">Min ${money(limits.min)}</button><button class="btn btn-small" data-action="set-buyin" data-value="${Math.round((limits.min + limits.max) / 2)}">Mid</button><button class="btn btn-small" data-action="set-buyin" data-value="${limits.max}">Max ${money(limits.max)}</button></div></div><div class="buyin-summary"><span><span>Demo stack</span><strong id="buyin-dollar">${money(state.buyInAmount)}</strong></span><span class="right"><span>Table label</span><strong id="buyin-token">${asset.symbol}</strong></span></div><div class="safety-box compact"><strong>Holding never gates the seat</strong><span>${escapeHtml(holdingNote)} No wallet spend, approval, or token lock is requested.</span></div>`, footer: `<span class="balance-note">${state.profile ? `${moneyAtomic(state.profile.demoCreditAtomic)} demo credits` : "Identity required"}</span><button class="btn btn-primary" data-action="take-seat">${state.profile ? "Take demo seat" : "Connect & continue"}</button>` }));
}

function hostModal() {
  if (!state.profile) { walletModal("host"); return; }
  openModal(modalShell({ wide: true, eyebrow: "Private safe-beta room", title: "Set your house rules", description: "The invite code is shown once. No real-value room can be created from this flow.", body: `<form id="host-form"><div class="form-grid"><label class="field field-full"><span class="field-label">Room name</span><input class="input" name="name" value="Friday Allocation" maxlength="32" required /></label><div class="field field-full"><span class="field-label">Game</span><div class="segmented"><button type="button" class="segment ${state.hostGame === "NLH" ? "active" : ""}" data-action="host-game" data-value="NLH">NLH</button><button type="button" class="segment ${state.hostGame === "PLO4" ? "active" : ""}" data-action="host-game" data-value="PLO4">PLO 4</button><button type="button" class="segment ${state.hostGame === "ROE" ? "active" : ""}" data-action="host-game" data-value="ROE">Round of each</button></div></div><label class="field"><span class="field-label">Small blind ($)</span><input class="input" name="smallBlind" type="number" min="0.01" step="0.01" value="0.10" required /></label><label class="field"><span class="field-label">Big blind ($)</span><input class="input" name="bigBlind" type="number" min="0.01" step="0.01" value="0.20" required /></label><label class="field"><span class="field-label">Seats</span><select class="select" name="seats"><option>2</option><option>4</option><option selected>6</option><option>8</option><option>9</option></select></label><label class="field"><span class="field-label">Minimum buy-in ($)</span><input class="input" name="minimumBuyIn" type="number" min="1" step="1" value="20" required /></label><label class="field"><span class="field-label">Maximum buy-in ($)</span><input class="input" name="maximumBuyIn" type="number" min="1" step="1" value="100" required /></label><label class="field"><span class="field-label">Rake (%)</span><input class="input" name="rakePercent" type="number" min="0" max="10" step="0.1" value="5" required /></label><label class="field"><span class="field-label">Rake cap ($)</span><input class="input" name="rakeCap" type="number" min="0.01" step="0.01" value="3" required /></label><label class="field"><span class="field-label">Action clock</span><select class="select" name="actionClockSeconds"><option>15</option><option selected>20</option><option>30</option><option>45</option></select></label><label class="field"><span class="field-label">Time bank</span><select class="select" name="timeBankSeconds"><option>30</option><option selected>60</option><option>90</option><option>120</option></select></label></div></form><p class="legal-note">Rake is simulated for rules-engine testing. It is not revenue and has no cash-out path.</p>`, footer: `<span class="balance-note">Invite stored as SHA-256 only</span><button class="btn btn-primary" data-action="create-room">Create beta room</button>` }));
}

async function createRoom() {
  const form = document.querySelector("#host-form"); if (!form.reportValidity()) return; const button = document.querySelector('[data-action="create-room"]'); button.disabled = true; button.textContent = "Creating…";
  const input = Object.fromEntries(new FormData(form)); input.game = state.hostGame;
  for (const key of ["smallBlind", "bigBlind", "seats", "minimumBuyIn", "maximumBuyIn", "rakePercent", "rakeCap", "actionClockSeconds", "timeBankSeconds"]) input[key] = Number(input[key]);
  try { const result = await api("/v1/beta/rooms", { method: "POST", authenticated: true, body: input }); closeModal(); await loadLobby({ quiet: true }); inviteCreatedModal(result.room, result.inviteCode); }
  catch (error) { button.disabled = false; button.textContent = "Create beta room"; toast(error.message); }
}

function inviteCreatedModal(room, code) { openModal(modalShell({ eyebrow: "Room ready", title: escapeHtml(room.name), description: "Copy this code now. Only its digest is retained by the server.", body: `<div class="invite-code">${escapeHtml(code)}</div><div class="safety-box"><strong>Share privately</strong><span>Anyone with this code can join the room membership list. The room still uses demo credits only.</span></div>`, footer: `<button class="btn" data-action="copy-code" data-code="${escapeHtml(code)}">Copy invite</button><button class="btn btn-primary" data-action="open-created-room" data-room="${room.id}">Open room</button>` })); }
function inviteModal() { if (!state.profile) { walletModal("invite"); return; } openModal(modalShell({ eyebrow: "Private membership", title: "Join with an invite", description: "Room invitations are matched by digest and never appear in the public lobby.", body: `<div class="invite-path"><span><i>1</i><strong>Enter the room code</strong><small>Format ABCD-2345</small></span><span><i>2</i><strong>Membership is added</strong><small>Bound to ${escapeHtml(shortWallet(state.profile.wallet))}</small></span><span><i>3</i><strong>Choose a demo seat</strong><small>No token approval</small></span></div><label class="field"><span class="field-label">Private room code</span><input class="input invite-input" id="invite-input" maxlength="9" placeholder="ABCD-2345" autocomplete="off" /></label>`, footer: `<span class="balance-note">Demo rooms only · code stored as a digest</span><button class="btn btn-primary" data-action="join-code">Join room</button>` })); }
async function joinInvite() { const button = document.querySelector('[data-action="join-code"]'); const code = document.querySelector("#invite-input").value; button.disabled = true; try { const result = await api("/v1/beta/rooms/join", { method: "POST", authenticated: true, body: { inviteCode: code } }); closeModal(); await loadLobby({ quiet: true }); toast(`Joined ${result.room.name}.`); } catch (error) { button.disabled = false; toast(error.message); } }

function buyStocksModal(asset = state.selectedAsset) { state.selectedAsset = asset; openModal(modalShell({ eyebrow: "Real asset boundary", title: `Get ${escapeHtml(asset.symbol)}`, description: "Real xStock purchase is intentionally outside the safe multiplayer beta.", body: `<div class="purchase-layout"><div><div class="field"><span class="field-label">Launch asset</span>${assetPicker(asset.symbol)}</div><div class="safety-box"><strong>Why this is paused</strong><span>A production in-app purchase needs xStocks integrator access, live quotes, jurisdiction screening, and a wallet-executed transaction. The beta does not fake any of those steps.</span></div></div><aside class="order-card"><span class="utility-label" style="color:#aebbb4">Current mode</span><div class="order-total">No quote</div><span class="quote-timer">Safe beta · transfers disabled</span><div class="order-row" style="margin-top:20px"><span>Wallet spend</span><strong>Disabled</strong></div><div class="order-row"><span>Table credits</span><strong>Simulated</strong></div><a class="btn btn-accent external-btn" href="https://xstocks.fi/" target="_blank" rel="noopener noreferrer">Visit xStocks ↗</a></aside></div>` })); }

async function takeSeat() {
  if (!state.profile) { closeModal(); walletModal("buyin"); return; }
  const button = document.querySelector('[data-action="take-seat"]'); button.disabled = true; button.textContent = "Seating…";
  if (state.backend !== "online") { closeModal(); state.tableId = "interface-preview"; state.tableVisual = { handId: null, boardCount: 0, holeCount: 0, potAtomic: 0, phase: null }; clearHoleCards(); state.tableState = previewTableState(); state.view = "table"; state.tableConnection = "preview"; render(); toast("Interface seat created locally. There is no multiplayer server on this deployment."); return; }
  try { const result = await api("/v1/beta/tables/join", { method: "POST", authenticated: true, body: { roomId: state.selectedRoom.id, assetSymbol: state.selectedAsset.symbol, buyInAtomic: String(Math.round(state.buyInAmount * 100)) } }); closeModal(); state.tableId = result.tableId; state.tableVisual = { handId: null, boardCount: 0, holeCount: 0, potAtomic: 0, phase: null }; state.tableState = result.state; state.view = "table"; clearHoleCards(); render(); connectRealtime(); toast(`${money(state.buyInAmount)} in demo credits seated. No funds moved.`); }
  catch (error) { button.disabled = false; button.textContent = "Take demo seat"; toast(error.message); }
}

function previewTableState() { return { version: 1, status: "WAITING", tableId: "interface-preview", rules: state.selectedRoom.rules, seats: [{ playerId: state.profile?.wallet || "PreviewPlayer", seat: 3, stackAtomic: String(state.buyInAmount * 100), status: "SEATED", timeBankMs: 60_000 }], handNumber: 0, buttonSeat: null, currentHand: null, lastResult: null }; }
function clearHoleCards() { state.holeHandId = null; state.holeCards = []; }
function clearHandPresentation() { clearTimeout(state.presentationTimer); state.presentationTimer = null; state.lastHandPresentation = null; }
function adoptTableState(nextState) {
  const currentHand = state.tableState?.currentHand;
  const nextHandId = nextState?.currentHand?.handId || null;
  if (currentHand && !nextHandId && nextState?.lastResult?.handId === currentHand.handId) {
    clearTimeout(state.presentationTimer);
    state.lastHandPresentation = {
      hand: structuredClone(currentHand),
      handId: currentHand.handId,
      holeCards: structuredClone(state.holeCards),
      result: structuredClone(nextState.lastResult),
    };
    state.presentationTimer = setTimeout(() => {
      if (!state.tableState?.currentHand && state.lastHandPresentation?.handId === currentHand.handId) {
        state.lastHandPresentation = null;
        if (state.view === "table") render();
      }
    }, 3_200);
  } else if (nextHandId && state.lastHandPresentation) clearHandPresentation();
  if (state.holeHandId !== nextHandId) clearHoleCards();
  state.tableState = nextState;
}

function tableVisualTransition(hand, boardCount, holeCount, potAtomic) {
  const handId = hand?.handId || null;
  const phase = hand?.betting?.phase || null;
  const previous = state.tableVisual;
  const handChanged = Boolean(handId && handId !== previous.handId);
  const boardStart = handChanged ? 0 : Math.min(previous.boardCount, boardCount);
  const holeStart = handChanged ? 0 : Math.min(previous.holeCount, holeCount);
  const previousPotAtomic = handChanged ? 0 : previous.potAtomic;
  const potChanged = Boolean(handId && previousPotAtomic !== potAtomic);
  const streetChanged = Boolean(handId && previous.handId === handId && previous.phase && previous.phase !== phase);
  state.tableVisual = { handId, boardCount, holeCount, potAtomic, phase };
  return { handChanged, boardStart, holeStart, potChanged, previousPotAtomic, streetChanged };
}

function seatName(player) { return player.playerId === state.profile?.wallet ? state.profile.displayName : shortWallet(player.playerId); }
const CARD_NAMES = Object.freeze({ A: "Ace", K: "King", Q: "Queen", J: "Jack", T: "Ten", 9: "Nine", 8: "Eight", 7: "Seven", 6: "Six", 5: "Five", 4: "Four", 3: "Three", 2: "Two" });
const SUIT_NAMES = Object.freeze({ "♣": "clubs", "♦": "diamonds", "♥": "hearts", "♠": "spades" });
const TABLE_SEAT_LAYOUTS = Object.freeze({
  2: [[50, 77], [50, 7]],
  3: [[50, 77], [88, 26], [12, 26]],
  4: [[50, 77], [90, 53], [50, 7], [10, 53]],
  5: [[50, 77], [87, 68], [81, 16], [19, 16], [13, 68]],
  6: [[50, 77], [86, 70], [88, 27], [50, 7], [12, 27], [14, 70]],
  7: [[50, 77], [76, 78], [92, 55], [79, 15], [21, 15], [8, 55], [24, 78]],
  8: [[50, 77], [77, 79], [92, 61], [83, 19], [50, 7], [17, 19], [8, 61], [23, 79]],
  9: [[50, 77], [74, 81], [92, 68], [91, 31], [71, 11], [29, 11], [9, 31], [8, 68], [26, 81]],
});

function cardHtml(code, { extra = "", index = 0, animate = false, style = "" } = {}) {
  const hidden = !code || code === "?";
  const safeCode = hidden ? "?" : String(code);
  const suit = hidden ? "" : safeCode.slice(-1);
  const rank = hidden ? "" : safeCode.slice(0, -1);
  const red = /[♥♦]/.test(suit) ? "red" : "";
  const suitClass = hidden ? "" : `suit-${SUIT_NAMES[suit] || "unknown"}`;
  const rankClass = hidden ? "" : `rank-${rank.toLowerCase()}`;
  const classes = ["card", red, suitClass, rankClass, hidden ? "face-down" : "face-up", animate ? "is-dealt" : "", extra].filter(Boolean).join(" ");
  const label = hidden ? "Face-down card" : `${CARD_NAMES[rank] || rank} of ${SUIT_NAMES[suit] || suit}`;
  if (hidden) return `<span class="${classes}" style="--deal-index:${index};${style}" role="img" aria-label="${label}"><span class="card-back-mark">xP</span></span>`;
  const indexRank = rank === "T" ? "10" : rank;
  return `<span class="${classes}" style="--deal-index:${index};${style}" role="img" aria-label="${escapeHtml(label)}"><span class="card-face" aria-hidden="true"><b>${escapeHtml(indexRank)}</b><i>${escapeHtml(suit)}</i></span></span>`;
}

function tableSeatLayout(table) {
  const count = Math.max(2, Math.min(9, Number(table.rules?.seats) || 6));
  const selfSeat = table.seats.find((player) => player.playerId === state.profile?.wallet)?.seat ?? table.seats[0]?.seat ?? 0;
  return TABLE_SEAT_LAYOUTS[count].map(([x, y], displayIndex) => ({ actualSeat: (selfSeat + displayIndex) % count, displayIndex, x, y }));
}

function turnTimerStyle(turn, playerId) {
  if (!turn || turn.playerId !== playerId) return "";
  const startedAt = Date.parse(turn.startedAt);
  const deadlineAt = Date.parse(turn.deadlineAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt)) return "";
  const duration = Math.max(1_000, deadlineAt - startedAt);
  const elapsed = Math.max(0, Math.min(duration, Date.now() - startedAt));
  return `--turn-duration:${duration}ms;--turn-delay:-${elapsed}ms;`;
}

function latestActionFor(hand, playerId) {
  const event = state.lastEvent;
  if (!hand || !event || !["ACTION_APPLIED", "ACTION_TIMED_OUT"].includes(event.type)) return null;
  if (event.payload?.betting?.handId && event.payload.betting.handId !== hand.handId) return null;
  if (event.payload?.playerId !== playerId) return null;
  const occurredAt = Date.parse(event.occurredAt);
  if (Number.isFinite(occurredAt) && Date.now() - occurredAt > 4_000) return null;
  const type = event.type === "ACTION_TIMED_OUT" ? "timeout" : String(event.payload?.action?.type || "action").toLowerCase();
  const labels = { fold: "FOLD", check: "CHECK", call: "CALL", bet: "BET", raise: "RAISE", timeout: "TIME OUT" };
  return { type, label: labels[type] || type.replaceAll("_", " ").toUpperCase() };
}

function chipStackHtml() {
  return '<span class="wager-chips" aria-hidden="true"><i></i><i></i><i></i></span>';
}

function tableSeat({ actualSeat, displayIndex, x, y }, visual, presentation = {}) {
  const table = state.tableState;
  const player = table?.seats.find((candidate) => candidate.seat === actualSeat);
  const hand = presentation.hand || table?.currentHand;
  const handPlayer = hand?.betting?.players.find((candidate) => candidate.seat === actualSeat);
  const active = hand?.turn?.playerId === player?.playerId;
  const isSelf = player?.playerId === state.profile?.wallet;
  const zone = y < 20 ? "top" : y > 75 ? "bottom" : x < 25 ? "left" : x > 75 ? "right" : "middle";
  const seatStyle = `--seat-x:${x}%;--seat-y:${y}%;--seat-index:${displayIndex};${turnTimerStyle(hand?.turn, player?.playerId)}`;
  if (!player) return `<div class="seat empty-seat zone-${zone}" style="${seatStyle}"><span class="empty-seat-ring" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span><span class="player-name">Open seat</span></div>`;

  const initials = isSelf ? "YOU" : shortWallet(player.playerId).slice(0, 2).toUpperCase();
  const expectedCards = hand?.game === "PLO4" ? 4 : 2;
  const inHand = Boolean(handPlayer);
  const visibleHoleCards = presentation.resultMode ? presentation.holeCards || [] : state.holeCards;
  const visibleHoleHandId = presentation.resultMode ? hand?.handId : state.holeHandId;
  const privateDealReady = Boolean(isSelf && inHand && visibleHoleHandId === hand?.handId && visibleHoleCards.length === expectedCards);
  const privateDealPending = Boolean(isSelf && inHand && !presentation.resultMode && !privateDealReady);
  const shownCards = privateDealReady ? visibleHoleCards.map((reveal) => reveal.card.code) : Array.from({ length: inHand ? expectedCards : 0 }, () => "?");
  const cards = shownCards.length ? `<span class="hole-cards ${isSelf ? "hero-cards" : "opponent-cards"} cards-${shownCards.length} ${privateDealPending ? "private-deal-pending" : ""}">${shownCards.map((code, index) => {
    const fanStep = isSelf && shownCards.length === 4 ? 2.2 : isSelf ? 4.5 : 3;
    const fan = (index - (shownCards.length - 1) / 2) * fanStep;
    const shouldAnimate = !presentation.resultMode && (privateDealReady ? index >= visual.holeStart : visual.handChanged);
    const privateReveal = privateDealReady && !visual.handChanged && visual.holeStart === 0;
    const dealDelay = privateReveal ? index * 72 : 180 + index * 190 + displayIndex * 42;
    return cardHtml(code, { extra: `${isSelf ? "private-card" : "opponent-card"} ${privateReveal ? "private-reveal" : ""}`, index, animate: shouldAnimate, style: `--card-rotate:${fan}deg;--deal-delay:${dealDelay}ms;` });
  }).join("")}</span>${privateDealPending ? '<span class="private-deal-status"><i></i>Securing your cards…</span>' : ""}` : "";
  const avatarColor = isSelf ? "#d8ff73" : ["#f5bd66", "#7cc8b3", "#ef8d79", "#83a8ff", "#c39aef", "#e5d27c"][displayIndex % 6];
  const flags = [handPlayer?.folded ? "folded" : "", handPlayer?.allIn ? "all-in" : "", player.status === "SITTING_OUT" ? "sitting-out" : ""].filter(Boolean).join(" ");
  const action = presentation.resultMode ? null : latestActionFor(hand, player.playerId);
  const payout = presentation.result?.payouts?.find((entry) => entry.playerId === player.playerId);
  const winner = Boolean(payout && Number(payout.amountAtomic) > 0);
  const stack = presentation.resultMode ? player.stackAtomic : (handPlayer?.stack ?? player.stackAtomic);
  const betIsNew = Boolean(handPlayer && handPlayer.streetContribution !== "0" && (visual.handChanged || action));
  return `<div class="seat zone-${zone} ${isSelf ? "is-self" : ""} ${active ? "active" : ""} ${winner ? "is-winner" : ""} ${flags}" style="${seatStyle}">${cards}${action ? `<span class="seat-action action-${escapeHtml(action.type)}">${escapeHtml(action.label)}</span>` : ""}<span class="player-avatar" style="--avatar-color:${avatarColor}"><span class="avatar-initials">${initials}</span>${active ? '<svg class="turn-ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" pathLength="100" /></svg>' : ""}${table.buttonSeat === player.seat ? '<span class="dealer-chip">D</span>' : ""}</span><span class="player-identity"><span class="player-name">${escapeHtml(seatName(player))}${isSelf ? '<small>YOU</small>' : ""}</span><span class="player-stack">${moneyAtomic(stack)} <b>${escapeHtml(state.selectedAsset.symbol)}</b></span></span>${handPlayer?.allIn ? '<span class="seat-state">ALL IN</span>' : ""}${winner ? `<span class="winner-payout">+${moneyAtomic(payout.amountAtomic)}</span>` : ""}${handPlayer && handPlayer.streetContribution !== "0" ? `<span class="seat-bet ${betIsNew ? "is-new" : ""}">${chipStackHtml()}<strong>${moneyAtomic(handPlayer.streetContribution)}</strong></span>` : ""}</div>`;
}

function fairnessRail() {
  const hand = state.tableState?.currentHand;
  const event = state.lastEvent;
  const completed = state.tableState?.lastResult?.handId;
  const root = hand?.deckRoot ? `${hand.deckRoot.slice(0, 6)}…${hand.deckRoot.slice(-4)}` : "Awaiting deal";
  return `<details class="fairness-rail"><summary class="fairness-title" aria-label="Show verified deal details"><span><i class="connection-dot ${state.tableConnection}"></i><strong>Verified deal</strong></span><span class="fairness-state"><small>${escapeHtml(state.tableConnection)}</small><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></span></summary><div class="fairness-detail"><div class="fairness-facts"><span><small>Sequence</small><strong>${state.tableState?.version ?? 0}</strong></span><span><small>Deck root</small><strong>${escapeHtml(root)}</strong></span><span><small>Last event</small><strong>${escapeHtml((event?.type || "Snapshot ready").replaceAll("_", " "))}</strong></span></div>${completed ? `<button class="audit-link" data-action="view-audit" data-hand="${escapeHtml(completed)}"><span>Audit last hand</span><b>↗</b></button>` : '<div class="fairness-seal"><span>✓</span> Merkle proofs on every reveal</div>'}</div></details>`;
}
function connectionRecoveryBanner() {
  if (["live", "preview"].includes(state.tableConnection)) return "";
  const offline = !state.networkOnline;
  const title = offline ? "Your device is offline" : state.tableConnection === "reconnecting" ? "Restoring the live table" : "Connecting to the table";
  const detail = offline ? "Your last confirmed sequence is preserved. Reconnect to the internet and xPoker will replay anything you missed." : `Holding at sequence ${state.tableState?.version ?? 0}. Actions are paused until the server confirms replay.`;
  return `<div class="reconnect-banner" role="status"><span class="reconnect-spinner"></span><div><strong>${title}</strong><small>${detail}</small></div><span class="reconnect-attempt">${offline ? "WAITING FOR NETWORK" : `ATTEMPT ${Math.max(1, state.reconnectAttempt + 1)}`}</span><button class="btn btn-small" data-action="retry-realtime" ${offline ? "disabled" : ""}>Retry now</button></div>`;
}
function actionDock() {
  const current = state.tableState?.currentHand; const legal = current?.legalActions;
  if (!["live", "preview"].includes(state.tableConnection)) return `<div class="action-dock waiting-dock connection-hold"><span><strong>Actions paused while reconnecting</strong><small>Your last confirmed table state stays visible. No action will be guessed or queued.</small></span><button class="btn" data-action="retry-realtime" ${state.networkOnline ? "" : "disabled"}>Retry</button></div>`;
  if (!current) return `<div class="action-dock waiting-dock"><span class="dock-status-icon"><i></i></span><span><strong>Waiting for the lineup</strong><small>Two active seats start the next cryptographically committed hand.</small></span><button class="btn" data-action="copy-table">Copy table ID</button></div>`;
  if (!legal) return `<div class="action-dock waiting-dock"><span class="dock-status-icon is-live"><i></i></span><span><strong>${current.turn ? `Action on ${escapeHtml(shortWallet(current.turn.playerId))}` : "Dealer resolving the street"}</strong><small>Live events update the table automatically.</small></span><span class="tag">Hand ${state.tableState.handNumber}</span></div>`;
  const primary = legal.canCheck ? ["check", "Check"] : ["call", `Call ${moneyAtomic(legal.callAmount)}`]; const increase = legal.canRaise || legal.canBet; const min = Number(legal.minimumTarget || 0); const max = Number(legal.maximumTarget || min);
  return `<div class="action-dock action-ready"><button class="btn fold-action" data-action="table-action" data-poker="fold" ${legal.canFold ? "" : "disabled"}><small>Give up</small><strong>Fold</strong></button><button class="btn btn-primary primary-action" data-action="table-action" data-poker="${primary[0]}"><small>${legal.canCheck ? "No wager" : "Match wager"}</small><strong>${primary[1]}</strong></button><div class="bet-control"><span>${legal.canBet ? "Bet to" : "Raise to"}</span><strong id="raise-value">${moneyAtomic(min)}</strong><input class="range" id="bet-range" type="range" min="${min}" max="${max}" value="${min}" step="1" ${increase ? "" : "disabled"} aria-label="Raise target" /><button class="range-submit" data-action="table-action" data-poker="${legal.canBet ? "bet" : "raise"}" ${increase ? "" : "disabled"}>${legal.canBet ? "Bet" : "Raise"}</button></div></div>`;
}

function resultDock(result) {
  const winners = (result?.payouts || []).filter((payout) => Number(payout.amountAtomic) > 0);
  const total = winners.reduce((sum, payout) => sum + Number(payout.amountAtomic), 0);
  const label = winners.length === 1 ? seatName({ playerId: winners[0].playerId }) : `${winners.length} players split the pot`;
  return `<div class="action-dock result-dock"><span class="result-check">✓</span><span><small>HAND COMPLETE</small><strong>${escapeHtml(label)}</strong></span><span class="result-total">+${moneyAtomic(total)} <small>${escapeHtml(state.selectedAsset.symbol)}</small></span><span class="result-next">Next verified shuffle…</span></div>`;
}

function revealedCardCode(value) { return typeof value === "string" ? value : value?.code || value?.card?.code || "?"; }

function tableView() {
  const room = state.selectedRoom;
  const table = state.tableState || previewTableState();
  const resultPresentation = !table.currentHand && state.lastHandPresentation?.handId === table.lastResult?.handId ? state.lastHandPresentation : null;
  const hand = table.currentHand || resultPresentation?.hand || null;
  const board = resultPresentation?.result?.boards?.[0]?.map(revealedCardCode) || hand?.publicReveals?.map((reveal) => reveal.card.code) || [];
  const potAtomic = hand?.betting?.players?.reduce((sum, player) => sum + Number(player.contributed), 0) || 0;
  const visibleHoleCount = resultPresentation?.holeCards?.length ?? state.holeCards.length;
  const visual = tableVisualTransition(hand, board.length, visibleHoleCount, potAtomic);
  const winners = resultPresentation?.result?.payouts?.filter((payout) => Number(payout.amountAtomic) > 0) || [];
  const tableMessage = resultPresentation ? `${winners.length === 1 ? seatName({ playerId: winners[0].playerId }) : "Split pot"} wins the hand` : table.status === "WAITING" ? table.seats.length < 2 ? `${table.seats.length}/${table.rules.seats} seated · waiting for a second player` : `${table.seats.length}/${table.rules.seats} seated · dealer preparing the next fair hand` : hand?.turn ? `Action is on ${shortWallet(hand.turn.playerId)}` : "Dealer is resolving the hand";
  const phase = resultPresentation ? "PAYOUT" : hand?.betting?.phase || (table.status === "WAITING" ? "TABLE OPEN" : "DEALING");
  const game = gameLabel(hand?.game || room.game);
  const presentation = { hand, resultMode: Boolean(resultPresentation), holeCards: resultPresentation?.holeCards, result: resultPresentation?.result };
  const seats = tableSeatLayout(table).map((seat) => tableSeat(seat, visual, presentation)).join("");
  const boardCards = Array.from({ length: 5 }, (_, index) => board[index]
    ? cardHtml(board[index], { extra: `community-card is-revealed ${index >= visual.boardStart ? "is-new-street" : ""}`, index, animate: !resultPresentation && index >= visual.boardStart, style: `--deal-x:${(2 - index) * 92}px;--deal-delay:${Math.max(0, index - visual.boardStart) * 105}ms;` })
    : `<span class="community-card board-slot" style="--deal-index:${index}" aria-hidden="true"></span>`).join("");
  const tableMotion = visual.handChanged ? '<div class="deal-curtain" aria-hidden="true"><span><b>x</b>P</span><small>VERIFIED SHUFFLE</small></div>' : "";
  const streetMotion = !resultPresentation && board.length > visual.boardStart ? `<span class="street-sweep street-${board.length === 3 ? "flop" : board.length === 4 ? "turn" : "river"}" aria-hidden="true"></span>` : "";
  return `<main class="table-page"><header class="table-bar"><div class="table-title"><button class="icon-btn table-exit" data-action="leave-table" aria-label="Leave table"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg></button><div><span class="table-kicker">${escapeHtml(game)} · ${moneyAtomic(room.rules.smallBlindAtomic)} / ${moneyAtomic(room.rules.bigBlindAtomic)}</span><h1>${escapeHtml(room.name)}</h1></div></div><div class="table-meta"><span class="tag"><small>Hand</small>#${table.handNumber}</span><span class="tag"><small>Sequence</small>${table.version}</span><span class="tag asset-table-tag"><small>Table asset</small>${escapeHtml(state.selectedAsset.symbol)}</span><span class="status-pill"><i class="market-dot"></i>Demo · no funds</span></div></header><section class="poker-stage ${resultPresentation ? "showing-result" : ""}">${connectionRecoveryBanner()}<div class="table-toast"><span></span>${escapeHtml(tableMessage)}</div>${fairnessRail()}<div class="table-wrap"><div class="poker-table"><div class="felt-grain"></div><div class="table-monogram" aria-hidden="true">xP</div>${tableMotion}<div class="pot-center ${visual.potChanged ? "is-pulsing" : ""}">${streetMotion}<span class="street-label">${escapeHtml(phase.replaceAll("_", " "))}</span><span class="pot-label"><span class="pot-marker" aria-hidden="true">${chipStackHtml()}</span><span class="utility-label">Pot</span></span><strong class="pot-total"><span class="pot-number" data-pot-from="${visual.previousPotAtomic}" data-pot-to="${potAtomic}">${moneyAtomic(potAtomic)}</span> <small>${escapeHtml(state.selectedAsset.symbol)}</small></strong><div class="board-cards" aria-label="Community cards">${boardCards}</div></div></div>${seats}</div>${resultPresentation ? resultDock(resultPresentation.result) : actionDock()}</section></main>`;
}

async function showProfile() {
  if (!state.profile) { walletModal(); return; }
  state.view = "profile"; render();
  if (state.backend !== "online") return;
  try { const result = await api("/v1/beta/profile", { authenticated: true }); state.profile = result.profile; render(); }
  catch (error) { toast(error.message); }
}
async function loadHandHistory() {
  if (!state.profile) { walletModal(); return; }
  state.view = "history"; state.loading = true; state.historyError = null; render();
  try { const result = await api("/v1/beta/hands?limit=50", { authenticated: true }); state.handHistory = result.hands || []; }
  catch (error) { toast(error.message); state.historyError = error.message || "history_unavailable"; }
  state.loading = false; render();
}
async function loadOperations() {
  if (!state.profile?.operatorRole) { toast("Operator access is required."); return; }
  state.view = "operations"; state.loading = true; render();
  try {
    const tasks = [api("/v1/admin/overview", { authenticated: true }), api("/v1/admin/players", { authenticated: true }), api("/v1/admin/reports", { authenticated: true })];
    if (state.profile.operatorRole === "admin") tasks.push(api("/v1/admin/invites", { authenticated: true }));
    const [overview, players, reports, invites] = await Promise.all(tasks);
    state.operations = overview; state.operationsPlayers = players.players || []; state.operationsReports = reports.reports || []; state.operationsInvites = invites?.invites || [];
  } catch (error) { toast(error.message); }
  state.loading = false; render();
}
async function saveProfile() {
  const form = document.querySelector("#profile-form"); if (!form?.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form));
  try { const result = await api("/v1/beta/profile", { method: "POST", authenticated: true, body: input }); state.profile = result.profile; render(); toast("Profile saved."); }
  catch (error) { toast(error.message); }
}
async function redeemBetaInvite() {
  const code = document.querySelector("#beta-invite-code")?.value;
  try { const result = await api("/v1/beta/invitations/redeem", { method: "POST", authenticated: true, body: { code } }); await loadLobby({ quiet: true }); state.view = "profile"; render(); toast(`Access granted for ${result.label}.`); }
  catch (error) { toast(error.message); }
}
async function createBetaInvite() {
  const form = document.querySelector("#operator-invite-form"); if (!form?.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form)); input.maxUses = Number(input.maxUses); input.expiresHours = Number(input.expiresHours);
  try { const result = await api("/v1/admin/invites", { method: "POST", authenticated: true, body: input }); await loadOperations(); openModal(modalShell({ eyebrow: "Closed-beta invitation", title: escapeHtml(result.invite.label), description: "Copy this code now. The server retained only its SHA-256 digest.", body: `<div class="invite-code beta-access-code">${escapeHtml(result.code)}</div><div class="safety-box"><strong>${result.invite.maxUses} redemptions</strong><span>Expires ${dateTime(result.invite.expiresAt)}. Each identity can redeem only once.</span></div>`, footer: `<span class="balance-note">One-time display</span><button class="btn btn-primary" data-action="copy-code" data-code="${escapeHtml(result.code)}">Copy code</button>` })); }
  catch (error) { toast(error.message); }
}
function reportModal(handId = "") { openModal(modalShell({ eyebrow: "Player safety", title: "Send a report", description: "Reports go to the operator queue and never affect balances or cards.", body: `<form id="report-form"><input type="hidden" name="handId" value="${escapeHtml(handId)}" /><label class="field"><span class="field-label">Category</span><select class="select" name="category"><option value="fairness">Fairness concern</option><option value="collusion">Possible collusion</option><option value="harassment">Harassment</option><option value="stalling">Stalling</option><option value="bug">Product bug</option><option value="other">Other</option></select></label><label class="field"><span class="field-label">Reported wallet <small>optional</small></span><input class="input" name="reportedWallet" placeholder="Solana address" /></label><label class="field"><span class="field-label">What happened?</span><textarea class="input textarea" name="details" minlength="10" maxlength="1000" required placeholder="Include the action, street, and what looked wrong."></textarea></label></form>`, footer: `<span class="balance-note">Operator-visible</span><button class="btn btn-primary" data-action="submit-report">Send report</button>` })); }
async function submitReport() { const form = document.querySelector("#report-form"); if (!form?.reportValidity()) return; const input = Object.fromEntries(new FormData(form)); if (!input.handId) delete input.handId; if (!input.reportedWallet) delete input.reportedWallet; try { await api("/v1/beta/reports", { method: "POST", authenticated: true, body: input }); closeModal(); toast("Report sent to the moderation queue."); } catch (error) { toast(error.message); } }
function moderationModal({ type, id, wallet, status }) { const terminal = ["resolved", "dismissed", "banned"].includes(status); openModal(modalShell({ eyebrow: "Append-only operator action", title: `${status[0].toUpperCase()}${status.slice(1)} ${type}`, description: "The target and your operator wallet will be written to the moderation ledger.", body: `<label class="field"><span class="field-label">Operator note ${terminal ? "· required" : "· optional"}</span><textarea class="input textarea" id="moderation-note" maxlength="1000" ${terminal ? "minlength=3 required" : ""} placeholder="Reason and any follow-up"></textarea></label>`, footer: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="submit-moderation" data-type="${type}" data-id="${escapeHtml(id || "")}" data-wallet="${escapeHtml(wallet || "")}" data-status="${escapeHtml(status)}">Confirm ${escapeHtml(status)}</button>` })); }
async function submitModeration(target) { const note = document.querySelector("#moderation-note")?.value || ""; const input = { status: target.dataset.status, note }; const path = target.dataset.type === "report" ? `/v1/admin/reports/${target.dataset.id}` : `/v1/admin/players/${encodeURIComponent(target.dataset.wallet)}`; try { await api(path, { method: "POST", authenticated: true, body: input }); closeModal(); await loadOperations(); toast(`${target.dataset.type === "report" ? "Report" : "Player"} updated.`); } catch (error) { toast(error.message); } }
async function resolveIncident(id) { try { await api(`/v1/admin/incidents/${id}/resolve`, { method: "POST", authenticated: true, body: {} }); await loadOperations(); toast("Incident marked resolved."); } catch (error) { toast(error.message); } }
function validProofBundle(payload) { return Boolean(payload?.auditBundle?.publicRecord?.deckRoot && payload?.auditBundle?.publicRecord?.beacon?.round && payload?.transcriptHead); }
async function downloadAudit(handId) {
  const buttons = [...document.querySelectorAll('[data-action="download-audit"]')].filter((button) => button.dataset.hand === handId);
  buttons.forEach((button) => { button.disabled = true; button.dataset.label = button.textContent; button.textContent = "Preparing…"; });
  state.proofDownload = { handId, status: "preparing" };
  try {
    const response = await fetch(`${API_ORIGIN}/v1/beta/hands/${handId}/audit/download`, { headers: apiHeaders(true) });
    const text = await response.text();
    let payload; try { payload = JSON.parse(text); } catch { throw new Error("The proof service returned invalid JSON."); }
    if (!response.ok) throw new Error(payload.message || "Proof download failed");
    if (!validProofBundle(payload)) throw new Error("The downloaded proof bundle is incomplete and was not saved.");
    const filename = `xpoker-${handId.replaceAll(":", "-")}-proof.json`;
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
    state.proofDownload = { handId, status: "saved", filename };
    buttons.forEach((button) => { button.textContent = "Saved ✓"; });
    toast(`Proof saved as ${filename}.`);
  } catch (error) {
    state.proofDownload = { handId, status: "error", error: error.message };
    buttons.forEach((button) => { button.disabled = false; button.textContent = button.dataset.label || "Save proof"; });
    toast(error.message);
  }
}

function render() { const views = { lobby: lobbyView, profile: profileView, history: handHistoryView, operations: operationsView }; document.querySelector("#app").innerHTML = state.loading ? `<div class="app-loading"><span class="brand-mark">xP</span><strong>Opening the safe floor…</strong></div>` : state.view === "table" ? tableView() : (views[state.view] || lobbyView)(); bindEvents(); }
function requestId(prefix = "web") { return `${prefix}:${crypto.randomUUID()}`; }
function sendRealtime(message) { if (state.socket?.readyState !== WebSocket.OPEN) { toast("Realtime connection is not ready yet."); return false; } state.socket.send(JSON.stringify(message)); return true; }
function wsOrigin() { return API_ORIGIN.replace(/^http/, "ws"); }

function connectRealtime() {
  clearTimeout(state.reconnectTimer); if (!state.tableId || !state.token || !API_ORIGIN || state.view !== "table") return;
  if (!navigator.onLine) { state.networkOnline = false; state.tableConnection = "offline"; state.reconnectReason = "browser_offline"; render(); return; }
  state.networkOnline = true; state.socket?.close(1000, "replace connection"); state.tableConnection = "connecting"; state.reconnectNextAt = null; render(); const socket = new WebSocket(`${wsOrigin()}/v1/realtime`, "xpoker.v1"); state.socket = socket;
  socket.addEventListener("open", () => { state.tableConnection = "authenticating"; sendRealtime({ type: "authenticate", requestId: requestId("auth"), token: state.token }); render(); });
  socket.addEventListener("message", async (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (state.socket !== socket) return;
    if (message.type === "authenticated") { state.tableConnection = "live"; state.reconnectAttempt = 0; state.reconnectReason = null; state.reconnectNextAt = null; state.lastConnectedAt = new Date().toISOString(); sendRealtime({ type: "subscribe", requestId: requestId("sub"), tableId: state.tableId, afterVersion: state.tableState?.version || 0 }); await beginHoleKeyExchange(); render(); }
    if (message.type === "table_snapshot") { adoptTableState(message.state); render(); }
    if (message.type === "command_result") {
      state.pendingTableAction = null;
      adoptTableState(message.state);
      if (message.requestId === state.leaveRequestId) { await completeTableLeave(); return; }
      render();
    }
    if (message.type === "table_event") { state.lastEvent = message.event; sendRealtime({ type: "subscribe", requestId: requestId("sync"), tableId: state.tableId, afterVersion: state.tableState?.version || 0 }); }
    if (message.type === "hole_card_key_established") {
      const holeKey = state.holeKey;
      if (holeKey) {
        holeKey.ready = completeHoleKeyExchange(message.serverPublicKey, holeKey);
        try { await holeKey.ready; } catch { if (state.socket === socket) socket.close(4400, "private deal key failed"); }
      }
    }
    if (message.type === "hole_cards") {
      const deliverySequence = ++state.holeDeliverySequence;
      try {
        const holeKey = state.holeKey;
        if (holeKey?.ready) await holeKey.ready;
        const payload = await decryptHoleCards(message.envelope, holeKey);
        if (!payload?.handId || payload.handId !== message.handId || !Array.isArray(payload.reveals)) throw new Error("Private-card hand identity is invalid");
        if (state.socket !== socket || deliverySequence !== state.holeDeliverySequence) return;
        state.holeHandId = payload.handId;
        state.holeCards = payload.reveals;
        render();
      } catch { if (state.socket !== socket) return; toast("Private cards could not be decrypted. Reconnecting safely."); socket.close(4400, "private deal decrypt failed"); }
    }
    if (message.type === "error") { state.pendingTableAction = null; render(); toast(message.message || "Realtime command failed."); }
  });
  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    if (!navigator.onLine) {
      state.tableConnection = "offline";
      state.reconnectReason = "browser_offline";
      state.reconnectNextAt = null;
      render();
      return;
    }
    if (event.code === 4401) {
      state.tableConnection = "offline";
      state.reconnectReason = "session_expired";
      clearLocalSession("expired");
      state.pendingAfterConnect = "table";
      render();
      walletModal("table");
      return;
    }
    state.tableConnection = event.code === 1000 ? "offline" : "reconnecting";
    state.reconnectReason = event.reason || `socket_${event.code}`;
    if (state.view === "table" && event.code !== 1000 && navigator.onLine) {
      const delay = Math.min(10_000, 500 * (2 ** state.reconnectAttempt));
      state.reconnectAttempt += 1;
      state.reconnectNextAt = Date.now() + delay;
      state.reconnectTimer = setTimeout(connectRealtime, delay);
    }
    render();
  });
  socket.addEventListener("error", () => { state.tableConnection = "reconnecting"; state.reconnectReason = "transport_error"; render(); });
}

function retryRealtime() { if (!state.networkOnline) return; clearTimeout(state.reconnectTimer); state.reconnectAttempt = 0; connectRealtime(); }

async function beginHoleKeyExchange() {
  if (!crypto.subtle || !state.profile) return;
  try { const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]); const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)); state.holeKey = { pair, aesKey: null, ready: null, wallet: state.profile.wallet }; sendRealtime({ type: "key_exchange", requestId: requestId("key"), clientPublicKey: bytesToBase64Url(rawPublic) }); }
  catch { toast("This browser cannot open encrypted private cards (X25519 unavailable). Public play state remains connected."); }
}

function base64UrlToBytes(value) { const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4); const binary = atob(base64); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
async function completeHoleKeyExchange(serverPublicKey, holeKey) { const serverKey = await crypto.subtle.importKey("raw", base64UrlToBytes(serverPublicKey), { name: "X25519" }, false, []); const shared = await crypto.subtle.deriveBits({ name: "X25519", public: serverKey }, holeKey.pair.privateKey, 256); const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]); const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`xpoker-hole-cards/v1:${holeKey.wallet}`)); holeKey.aesKey = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("xpoker-hole-cards/v1") }, hkdfKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]); }
async function decryptHoleCards(envelope, holeKey = state.holeKey) { if (!holeKey?.aesKey) throw new Error("Private-card key is unavailable"); const { iv, ciphertext, tag, ...aad } = envelope; const cipher = base64UrlToBytes(ciphertext); const authTag = base64UrlToBytes(tag); const combined = new Uint8Array(cipher.length + authTag.length); combined.set(cipher); combined.set(authTag, cipher.length); const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: new TextEncoder().encode(canonicalJson(aad)), tagLength: 128 }, holeKey.aesKey, combined); return JSON.parse(new TextDecoder().decode(plaintext)); }

function playTableActionMotion(type, amountAtomic = 0) {
  const seat = document.querySelector(".table-page .seat.is-self");
  const pot = document.querySelector(".table-page .pot-center");
  if (!seat || !pot) return;
  const labels = { fold: "FOLD", check: "CHECK", call: "CALL", bet: "BET", raise: "RAISE" };
  const cue = document.createElement("span");
  cue.className = `seat-action local-action action-${type}`;
  cue.textContent = labels[type] || type.toUpperCase();
  seat.appendChild(cue);
  cue.addEventListener("animationend", () => cue.remove(), { once: true });
  if (!amountAtomic || ["check", "fold"].includes(type)) return;
  const source = seat.querySelector(".player-avatar")?.getBoundingClientRect() || seat.getBoundingClientRect();
  const target = pot.getBoundingClientRect();
  const flight = document.createElement("span");
  flight.className = "action-chip-flight";
  flight.innerHTML = chipStackHtml();
  flight.style.left = `${source.left + source.width / 2}px`;
  flight.style.top = `${source.top + source.height / 2}px`;
  document.body.appendChild(flight);
  const finishX = source.left + source.width / 2 + (target.left + target.width / 2 - source.left - source.width / 2) * 0.55;
  const finishY = source.top + source.height / 2 + (target.top + target.height / 2 - source.top - source.height / 2) * 0.55;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !flight.animate) { flight.remove(); return; }
  flight.animate([
    { opacity: 0, transform: "translate(-50%, -50%) scale(.6)" },
    { opacity: 1, offset: .18, transform: "translate(-50%, -70%) scale(1.05)" },
    { opacity: 1, transform: `translate(calc(-50% + ${finishX - source.left - source.width / 2}px), calc(-50% + ${finishY - source.top - source.height / 2}px)) scale(.92)` },
  ], { duration: 520, easing: "cubic-bezier(.2,.82,.25,1)", fill: "forwards" }).finished.finally(() => flight.remove());
}

function tableAction(type) {
  const hand = state.tableState?.currentHand;
  if (!hand?.legalActions || state.pendingTableAction) return;
  const action = { type };
  if (type === "raise" || type === "bet") action.to = document.querySelector("#bet-range").value;
  const amountAtomic = type === "call" ? Number(hand.legalActions.callAmount || 0) : Number(action.to || 0);
  const request = { type: "command", command: "act", requestId: requestId("act"), tableId: state.tableId, expectedVersion: state.tableState.version, expectedBettingVersion: hand.betting.version, idempotencyKey: requestId("idem"), action };
  if (!sendRealtime(request)) return;
  state.pendingTableAction = { requestId: request.requestId, type };
  document.querySelectorAll(".action-ready button").forEach((button) => { button.disabled = true; });
  document.querySelector(".action-ready")?.classList.add("is-committing");
  playTableActionMotion(type, amountAtomic);
}
async function completeTableLeave() { state.leaveRequestId = null; state.socket?.close(1000, "left table"); state.tableId = null; state.tableState = null; state.holeKey = null; clearHoleCards(); clearHandPresentation(); state.pendingTableAction = null; state.tableVisual = { handId: null, boardCount: 0, holeCount: 0, potAtomic: 0, phase: null }; state.lastEvent = null; state.view = "lobby"; await loadLobby({ quiet: true }); toast("Demo seat released. No funds moved."); }
function leaveTable() {
  if (!state.tableId || state.tableId === "interface-preview" || state.tableConnection !== "live") { completeTableLeave(); return; }
  if (state.leaveRequestId) return;
  const id = requestId("leave"); state.leaveRequestId = id;
  if (!sendRealtime({ type: "command", command: "leave", requestId: id, tableId: state.tableId, expectedVersion: state.tableState.version, idempotencyKey: requestId("idem") })) state.leaveRequestId = null;
}
async function logout() { try { if (state.token && state.backend === "online") await api("/v1/auth/logout", { method: "POST", authenticated: true, body: {} }); } catch {} try { await window.xPokerPrivy?.logout?.(); } catch {} clearLocalSession(); state.operations = null; state.view = "lobby"; state.socket?.close(1000, "logout"); closeModal(); await loadLobby({ quiet: true }); toast("Beta session ended."); }
async function viewAudit(handId) {
  if (state.backend !== "online") { toast("A completed authoritative hand is required for an audit."); return; }
  try {
    const result = await api(`/v1/beta/hands/${handId}/audit`, { authenticated: true });
    state.audit = result;
    const record = result.auditBundle.publicRecord;
    openModal(modalShell({
      eyebrow: "Post-hand verification",
      title: `Hand #${escapeHtml(handId.split(":").at(-1))} audit passed`,
      description: "The pinned drand round was signature-verified again before returning this bundle.",
      body: `<div class="audit-grid"><div><span>Deck root</span><strong>${escapeHtml(record.deckRoot)}</strong></div><div><span>Rules hash</span><strong>${escapeHtml(record.rulesHash)}</strong></div><div><span>drand round</span><strong>${record.beacon.round}</strong></div><div><span>Transcript head</span><strong>${escapeHtml(result.transcriptHead)}</strong></div></div><div class="safety-box"><strong>What this proves</strong><span>The revealed seeds reconstruct the committed 52-card deck, the external beacon matches the reserved signed round, and the signed transcript head binds the lifecycle.</span></div><div class="proof-package"><span class="proof-package-icon">↓</span><div><strong>Portable reconstruction proof</strong><span>The saved JSON includes the public record, reveals, transcript bindings, and verification material. Keep it independently of xPoker.</span></div></div>`,
      footer: `<span class="status-pill"><i class="market-dot"></i>Beacon verified</span><div class="inline-actions"><button class="btn btn-primary" data-action="download-audit" data-hand="${escapeHtml(handId)}">Save proof JSON</button><button class="btn" data-action="copy-audit">Copy JSON</button></div>`,
    }));
  } catch (error) { toast(error.message); }
}
function toast(message) { const root = document.querySelector("#toast-root"); const element = document.createElement("div"); element.className = "toast"; element.textContent = message; root.appendChild(element); setTimeout(() => element.remove(), 4_200); }

function bindEvents(root = document) {
  root.querySelectorAll("[data-action]").forEach((element) => { if (element.dataset.bound) return; element.dataset.bound = "true"; element.addEventListener("click", handleAction); if (element.classList.contains("room-card")) element.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); element.click(); } }); });
  root.querySelectorAll(".wallet-choice-logo img").forEach((image) => {
    if (image.dataset.fallbackBound) return;
    image.dataset.fallbackBound = "true";
    const showFallback = () => { image.hidden = true; };
    if (image.complete && !image.naturalWidth) showFallback();
    else image.addEventListener("error", showFallback, { once: true });
  });
  root.querySelector("#buyin-range")?.addEventListener("input", (event) => { state.buyInAmount = Number(event.target.value); document.querySelector("#buyin-dollar").textContent = money(state.buyInAmount); });
  root.querySelector("#bet-range")?.addEventListener("input", (event) => { document.querySelector("#raise-value").textContent = moneyAtomic(event.target.value); });
  root.querySelectorAll(".pot-number[data-pot-from][data-pot-to]").forEach((element) => {
    const from = Number(element.dataset.potFrom || 0); const to = Number(element.dataset.potTo || 0);
    if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const startedAt = performance.now(); const duration = 520;
    const tick = (now) => { const progress = Math.min(1, (now - startedAt) / duration); const eased = 1 - (1 - progress) ** 3; element.textContent = moneyAtomic(Math.round(from + (to - from) * eased)); if (progress < 1 && element.isConnected) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

function handleAction(event) {
  const target = event.currentTarget; const action = target.dataset.action;
  if (action === "close-modal") { if (!target.classList.contains("modal-overlay") || event.target === target) closeModal(); }
  if (action === "go-lobby") { event.preventDefault(); state.socket?.close(1000, "left table view"); state.view = "lobby"; closeModal(); loadLobby({ quiet: true }); }
  if (action === "show-profile") showProfile(); if (action === "show-history" || action === "refresh-history") loadHandHistory(); if (action === "show-operations" || action === "refresh-operations") loadOperations();
  if (action === "leave-table") { event.preventDefault(); leaveTable(); }
  if (action === "open-wallet") walletModal(); if (action === "connect-privy-wallet") connectPrivy(target); if (action === "connect-provider") connectProvider(target); if (action === "guest-session") createGuestSession(); if (action === "preview-session") createPreviewSession(); if (action === "logout") logout();
  if (action === "show-guest-login") { state.walletEntryMode = "guest"; walletModal(); } if (action === "show-wallet-login") { state.walletEntryMode = "wallet"; walletModal(); }
  if (action === "refresh-holdings") loadHoldings(); if (action === "copy-site-link") { navigator.clipboard?.writeText(location.href); toast("xPoker link copied. Open it inside your mobile wallet browser."); }
  if (action === "retry-realtime") retryRealtime();
  if (action === "open-host") hostModal(); if (action === "open-invite") inviteModal(); if (action === "join-code") joinInvite();
  if (action === "save-profile") saveProfile(); if (action === "redeem-beta-invite") redeemBetaInvite();
  if (action === "focus-bankroll") document.querySelector("#bankroll")?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (action === "open-buy") buyStocksModal(); if (action === "asset-info") buyStocksModal(state.assets.find((asset) => asset.symbol === target.dataset.symbol));
  if (action === "open-buyin") buyinModal(state.rooms.find((room) => room.id === target.dataset.room)); if (action === "quick-seat") buyinModal(state.rooms.find((room) => room.visibility === "public" && Number(room.seatsTaken) < room.rules.seats) || state.rooms[0]);
  if (action === "select-asset") { state.selectedAsset = state.assets.find((asset) => asset.symbol === target.dataset.symbol); if (document.querySelector("#buyin-range")) buyinModal(state.selectedRoom); else buyStocksModal(state.selectedAsset); }
  if (action === "set-buyin") { state.buyInAmount = Number(target.dataset.value); document.querySelector("#buyin-range").value = state.buyInAmount; document.querySelector("#buyin-dollar").textContent = money(state.buyInAmount); }
  if (action === "take-seat") takeSeat(); if (action === "host-game") { state.hostGame = target.dataset.value; target.parentElement.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === target)); }
  if (action === "create-room") createRoom(); if (action === "copy-code") { navigator.clipboard?.writeText(target.dataset.code); toast("Invite code copied."); }
  if (action === "create-beta-invite") createBetaInvite();
  if (action === "open-created-room") { const room = state.rooms.find((item) => item.id === target.dataset.room); closeModal(); buyinModal(room); }
  if (action === "table-action") tableAction(target.dataset.poker); if (action === "copy-table") { navigator.clipboard?.writeText(state.tableId); toast("Table ID copied."); }
  if (action === "view-audit") viewAudit(target.dataset.hand); if (action === "download-audit") downloadAudit(target.dataset.hand); if (action === "copy-audit") { navigator.clipboard?.writeText(JSON.stringify(state.audit, null, 2)); toast("Audit bundle copied."); }
  if (action === "open-report") reportModal(target.dataset.hand); if (action === "submit-report") submitReport();
  if (action === "moderate-report") moderationModal({ type: "report", id: target.dataset.id, status: target.dataset.status });
  if (action === "moderate-player") moderationModal({ type: "player", wallet: target.dataset.wallet, status: target.dataset.status });
  if (action === "submit-moderation") submitModeration(target); if (action === "resolve-incident") resolveIncident(target.dataset.id);
}

document.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.querySelector(".modal-overlay")) closeModal(); });
function refreshWallets() {
  state.wallets = compatibleWallets(walletRegistry.get(), legacyWallets(window));
  if (document.querySelector("[data-wallet-entry]") && !state.profile && state.walletEntryMode === "wallet") walletModal();
}
walletRegistry.onChange(refreshWallets);
window.addEventListener("xpoker:privy-ready", (event) => {
  state.privyReady = Boolean(event.detail?.ready);
  if (document.querySelector("[data-wallet-entry]") && !state.profile && state.walletEntryMode === "wallet") walletModal();
});
window.addEventListener("offline", () => {
  state.networkOnline = false;
  if (state.view === "table") {
    state.tableConnection = "offline";
    state.reconnectReason = "browser_offline";
    state.socket?.close(4001, "browser offline");
    render();
  }
});
window.addEventListener("online", () => {
  state.networkOnline = true;
  if (state.view === "table" && state.tableConnection !== "live") retryRealtime();
});
refreshWallets();
setTimeout(refreshWallets, 750);
render();
loadLobby();
