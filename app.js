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
const state = {
  view: "lobby", loading: true, backend: API_ORIGIN ? "connecting" : "preview",
  assets: FALLBACK_ASSETS, rooms: FALLBACK_ROOMS, profile: null, token: sessionStorage.getItem(SESSION_KEY),
  selectedRoom: FALLBACK_ROOMS[0], selectedAsset: FALLBACK_ASSETS[0], buyInAmount: 20, hostGame: "NLH",
  tableId: null, tableState: null, tableConnection: "offline", socket: null, reconnectTimer: null,
  reconnectAttempt: 0, holeKey: null, holeCards: [], lastEvent: null, pendingAfterConnect: null, audit: null,
  leaveRequestId: null,
};

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function moneyAtomic(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0) / 100); }
function money(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }
function shortWallet(value) { return !value ? "Not connected" : value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value; }
function assetDetails(asset) { const [short, color, move] = ASSET_STYLE[asset.symbol] || [asset.symbol.slice(0, 2), "#dfe5e0", "Demo"]; return { ...asset, short, color, move, price: asset.indicativePrice || asset.price || 1 }; }
function assetLogo(asset) { const item = assetDetails(asset); return `<span class="asset-logo" style="--asset-color:${item.color}" title="${escapeHtml(item.name)}">${escapeHtml(item.short)}</span>`; }
function roomLimits(room) { return { min: Number(room.rules.minimumBuyInAtomic) / 100, max: Number(room.rules.maximumBuyInAtomic) / 100, small: Number(room.rules.smallBlindAtomic) / 100, big: Number(room.rules.bigBlindAtomic) / 100 }; }
function gameLabel(game) { return game === "PLO4" ? "PLO 4" : game === "ROE" ? "NLH ↔ PLO 4" : game; }

function apiHeaders(authenticated = false) { const headers = { "content-type": "application/json" }; if (authenticated && state.token) headers.authorization = `Bearer ${state.token}`; return headers; }
async function api(path, { method = "GET", body, authenticated = false } = {}) {
  if (!API_ORIGIN) throw new Error("The authoritative beta server is not configured on this deployment.");
  const response = await fetch(`${API_ORIGIN}${path}`, { method, headers: apiHeaders(authenticated), body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.message || payload.error || `Request failed (${response.status})`); error.status = response.status; throw error; }
  return payload;
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
    try { normalizeLobby(await api("/v1/beta/lobby", { authenticated: Boolean(state.token) })); state.backend = "online"; }
    catch { state.backend = "unavailable"; if (!quiet) toast("Safe-beta server unavailable. Showing interface preview."); normalizeLobby({}); }
  } else { state.backend = "preview"; normalizeLobby({}); }
  state.loading = false; render();
}

function navItem(icon, label, action, active = false) { return `<button class="nav-item ${active ? "active" : ""}" data-action="${action}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`; }
function sidebar() { return `<aside class="sidebar"><a class="brand" href="#" data-action="go-lobby" aria-label="xPoker home"><span class="brand-mark">xP</span><span class="brand-word">xPoker</span></a><div class="nav-label">Game floor</div><nav class="nav-list" aria-label="Primary navigation">${navItem("⌁", "Tables", "go-lobby", true)}${navItem("＋", "Host room", "open-host")}${navItem("#", "Join invite", "open-invite")}${navItem("◫", "Demo credits", "focus-bankroll")}</nav><div class="sidebar-card"><div class="mini-row"><span class="utility-label">Runtime</span><span class="status-pill"><i class="market-dot"></i>${state.backend === "online" ? "Authoritative" : "Preview"}</span></div><strong>Proof before the pot.</strong><p>Table actions are versioned and replayable. Beta credits cannot be deposited, withdrawn, or settled onchain.</p></div></aside>`; }
function topbar() { const wallet = state.profile?.wallet; return `<header class="topbar"><div class="crumbs"><span>Game floor</span><span>／</span><strong>Safe multiplayer beta</strong></div><div class="top-actions"><span class="quote-status"><i class="market-dot"></i>${state.backend === "online" ? "Live beta · demo credits" : "Interface preview · no server"}</span><button class="btn btn-ghost btn-small" data-action="open-buy">Get xStocks</button><button class="btn ${wallet ? "" : "btn-primary"} wallet-btn" data-action="open-wallet">${wallet ? `<span class="wallet-avatar">${state.profile.isGuest ? "D" : "W"}</span>${escapeHtml(shortWallet(wallet))}` : "Connect / enter beta"}</button></div></header>`; }

function marketRail() { return `<section class="market-rail" aria-label="Eligible table denominations"><div class="rail-intro"><strong>Core 10</strong><span>Demo denominations</span></div><div class="asset-strip">${state.assets.map((asset) => { const item = assetDetails(asset); return `<button class="asset-quote" data-action="asset-info" data-symbol="${item.symbol}" aria-label="View ${escapeHtml(item.name)}">${assetLogo(item)}<span class="asset-meta"><strong>${item.symbol}</strong><small>${item.move}</small></span></button>`; }).join("")}</div></section>`; }
function roomCard(room, index) { const limits = roomLimits(room); const accents = ["#d7ff86", "#ccecff", "#ddd5ff", "#ffc7c5"]; const seats = room.rules.seats; return `<article class="room-card" style="--room-accent:${accents[index % accents.length]}" data-action="open-buyin" data-room="${room.id}" tabindex="0" aria-label="Join ${escapeHtml(room.name)}"><div class="room-top"><span class="game-pill">${gameLabel(room.game)}</span><span class="status-pill"><i class="market-dot"></i>${state.backend === "online" ? "Live" : "Preview"}</span></div><h3>${escapeHtml(room.name)}</h3><span class="blinds">${money(limits.small)} / ${money(limits.big)} · ${seats} max</span><div class="room-stats"><div class="room-stat"><span>Demo buy-in</span><strong>${money(limits.min)}–${money(limits.max)}</strong></div><div class="room-stat"><span>Rake model</span><strong>${(Number(room.rules.rakeBps) / 100).toFixed(1)}%</strong></div></div><div class="room-footer"><div class="avatar-stack">${Array.from({ length: Math.min(Number(room.seatsTaken || 0), 4) }, (_, seat) => `<span class="avatar" style="--avatar-color:${accents[(seat + index + 1) % accents.length]}">${["LM", "AK", "RZ", "JS"][seat]}</span>`).join("")}</div><span class="seat-count">${Number(room.seatsTaken || 0)}/${seats} seated →</span></div></article>`; }

function privatePanel() {
  const privateRooms = state.rooms.filter((room) => room.visibility === "private");
  return `<section class="private-panel"><div class="section-head"><div><h2>Your private rooms</h2><p>Membership is stored server-side; invite codes are hashed.</p></div><div class="inline-actions"><button class="btn btn-small" data-action="open-invite">Join code</button><button class="btn btn-small" data-action="open-host">＋ New room</button></div></div><div class="private-list">${privateRooms.length ? privateRooms.map((room, index) => { const limits = roomLimits(room); return `<div class="private-room"><span class="private-icon" style="background:${index % 2 ? "#ccecff" : "#ddd5ff"}">${room.game === "PLO4" ? "4c" : room.game === "ROE" ? "↻" : "2c"}</span><span class="private-copy"><strong>${escapeHtml(room.name)}</strong><span>${gameLabel(room.game)} · ${money(limits.small)} / ${money(limits.big)} · ${room.seatsTaken || 0}/${room.rules.seats} seated</span></span><button class="btn btn-small" data-action="open-buyin" data-room="${room.id}">Open</button></div>`; }).join("") : `<div class="panel-empty"><strong>No private rooms yet.</strong><span>Create one or join with an invite code.</span></div>`}</div></section>`;
}

function bankrollPanel() { const credits = state.profile ? moneyAtomic(state.profile.demoCreditAtomic) : "$0.00"; return `<aside class="bankroll-panel" id="bankroll"><div class="bankroll-head"><span class="utility-label">Non-withdrawable balance</span><div class="balance">${credits}</div><span class="balance-note">Simulated credits · no monetary value</span></div><div class="bankroll-body">${state.profile ? `<div class="holding">${assetLogo(state.selectedAsset)}<span><strong>SAFE BETA</strong><span>${escapeHtml(state.profile.displayName)}</span></span><span class="holding-value"><strong>${state.profile.isGuest ? "Guest" : "Wallet"}</strong><span>${escapeHtml(shortWallet(state.profile.wallet))}</span></span></div><div class="safety-list"><span>✓ Cannot deposit</span><span>✓ Cannot withdraw</span><span>✓ Cannot settle onchain</span></div><div class="bankroll-actions"><button class="btn btn-small" data-action="open-wallet">Session</button><button class="btn btn-small btn-accent" data-action="quick-seat">Find seat</button></div>` : `<div class="empty-balance"><span class="empty-orbit">0 USD</span><strong>Enter without risking funds.</strong><p>Sign with a Solana wallet, or create an expiring guest identity to test multiplayer.</p><button class="btn btn-primary" data-action="open-wallet">Enter safe beta</button></div>`}</div></aside>`; }

function lobbyView() { return `<div class="app-shell">${sidebar()}<main class="page">${topbar()}<div class="content"><section class="hero"><div><span class="eyebrow">Authoritative multiplayer · zero-value beta</span><h1>Play the <em>market.</em></h1><p class="hero-copy">Choose an xStock denomination, take a seat with simulated credits, and test real wallet authentication, live table events, and reconnects. No token approval is requested and no funds can move.</p></div><div class="hero-actions"><button class="btn btn-primary" data-action="quick-seat">Find a beta seat</button><button class="btn" data-action="open-host">Host private room</button></div></section><div class="beta-boundary"><span class="boundary-mark">β</span><div><strong>Safe boundary</strong><span>xStock names set the table denomination only. Balances, pots, and rake below are simulated accounting.</span></div><span class="boundary-state">FUNDS MOVE: NO</span></div>${marketRail()}<section><div class="section-head"><div><h2>The public floor</h2><p>Four permanent rooms. Every seat starts from $20 in demo credits.</p></div><span class="tag">NLH · PLO 4 · ROE</span></div><div class="public-grid">${state.rooms.filter((room) => room.visibility === "public").map(roomCard).join("")}</div></section><div class="dashboard-row">${privatePanel()}${bankrollPanel()}</div></div></main></div>`; }

function modalShell({ eyebrow, title, description = "", body, footer = "", wide = false }) { return `<div class="modal-overlay" data-action="close-modal"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header class="modal-head"><div><span class="eyebrow">${eyebrow}</span><h2 id="modal-title">${title}</h2>${description ? `<p>${description}</p>` : ""}</div><button class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-foot">${footer}</footer>` : ""}</section></div>`; }
function openModal(html) { document.querySelector("#modal-root").innerHTML = html; document.body.style.overflow = "hidden"; bindEvents(document.querySelector("#modal-root")); setTimeout(() => document.querySelector(".modal button, .modal input")?.focus(), 0); }
function closeModal() { document.querySelector("#modal-root").innerHTML = ""; document.body.style.overflow = ""; }

function walletModal(after = null) {
  state.pendingAfterConnect = after; const serverReady = state.backend === "online";
  openModal(modalShell({ eyebrow: "Identity, not custody", title: state.profile ? "Your beta session" : "Enter the safe beta", description: "Wallet signatures prove account ownership. They never authorize a token transfer.", body: state.profile ? `<div class="session-card"><span class="wallet-avatar">${state.profile.isGuest ? "D" : "W"}</span><div><strong>${escapeHtml(state.profile.displayName)}</strong><span>${escapeHtml(state.profile.wallet)}</span></div><span class="status-pill"><i class="market-dot"></i>Active</span></div><div class="safety-box"><strong>This session can</strong><span>Join beta rooms, send poker actions, and resume a table.</span><strong>This session cannot</strong><span>Spend tokens, approve a program, deposit, withdraw, or cash out.</span></div>` : `<div class="provider-list"><button class="provider" data-action="connect-provider" data-provider="Phantom" ${serverReady ? "" : "disabled"}><span class="provider-logo">PH</span><span><strong>Phantom</strong><span>Connect and sign one domain-bound message</span></span><small>Recommended</small></button><button class="provider" data-action="connect-provider" data-provider="Backpack" ${serverReady ? "" : "disabled"}><span class="provider-logo">BP</span><span><strong>Backpack</strong><span>Connect and sign one domain-bound message</span></span><small>Solana</small></button></div><div class="or-divider"><span>or test without a wallet</span></div><div class="guest-row"><label class="field"><span class="field-label">Display name</span><input class="input" id="guest-name" maxlength="24" value="Market Player" /></label><button class="btn btn-accent" data-action="guest-session" ${serverReady ? "" : "disabled"}>Create guest session</button></div>${serverReady ? "" : `<div class="preview-fallback"><p class="legal-note warning-note">This deployment is currently the interface preview. Multiplayer and signed sessions need the authoritative API.</p><button class="btn" data-action="preview-session">Open interface preview</button></div>`}`, footer: state.profile ? `<span class="balance-note">Token expires automatically</span><button class="btn" data-action="logout">End session</button>` : `<span class="balance-note">No transaction is created</span><span class="status-pill">Funds move: no</span>` }));
}

function providerFor(name) { if (name === "Phantom") return window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null); if (name === "Backpack") return window.backpack?.solana || (window.solana?.isBackpack ? window.solana : null); return null; }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }

async function connectProvider(button) {
  const providerName = button.dataset.provider; const provider = providerFor(providerName);
  if (!provider) { toast(`${providerName} was not found in this browser.`); return; }
  button.disabled = true; button.querySelector("small").textContent = "Signing…";
  try {
    const connection = await provider.connect(); const wallet = String(connection.publicKey || provider.publicKey);
    const challenge = await api("/v1/auth/challenge", { method: "POST", body: { wallet } });
    const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
    const verified = await api("/v1/auth/verify", { method: "POST", body: { id: challenge.id, wallet, signature: bytesToBase64Url(signed.signature || signed) } });
    state.token = verified.token; sessionStorage.setItem(SESSION_KEY, state.token); closeModal(); await loadLobby({ quiet: true });
    toast(`${providerName} ownership verified. No transaction was requested.`); resumePendingAction();
  } catch (error) { button.disabled = false; button.querySelector("small").textContent = "Try again"; toast(error.message || "Wallet sign-in failed."); }
}

async function createGuestSession() {
  const input = document.querySelector("#guest-name"); const button = document.querySelector('[data-action="guest-session"]');
  button.disabled = true; button.textContent = "Creating…";
  try { const result = await api("/v1/beta/demo-session", { method: "POST", body: { displayName: input.value } }); state.token = result.token; sessionStorage.setItem(SESSION_KEY, state.token); closeModal(); await loadLobby({ quiet: true }); toast("Guest session ready. It has no monetary value."); resumePendingAction(); }
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

function resumePendingAction() { const pending = state.pendingAfterConnect; state.pendingAfterConnect = null; if (pending === "buyin") buyinModal(state.selectedRoom); if (pending === "host") hostModal(); }
function assetPicker(selectedSymbol) { return `<div class="asset-picker">${state.assets.map((asset) => `<button class="asset-option ${asset.symbol === selectedSymbol ? "selected" : ""}" data-action="select-asset" data-symbol="${asset.symbol}">${assetLogo(asset)}<strong>${asset.symbol}</strong></button>`).join("")}</div>`; }

function buyinModal(room) {
  state.selectedRoom = room; const limits = roomLimits(room); state.buyInAmount = Math.max(limits.min, Math.min(state.buyInAmount, limits.max)); const asset = assetDetails(state.selectedAsset);
  openModal(modalShell({ eyebrow: `${gameLabel(room.game)} · ${money(limits.small)} / ${money(limits.big)}`, title: `Take a demo seat at ${escapeHtml(room.name)}`, description: `Min ${money(limits.min)} · Max ${money(limits.max)}. This amount is simulated and non-withdrawable.`, body: `<div class="field"><span class="field-label">Choose table denomination</span>${assetPicker(asset.symbol)}</div><div class="field" style="margin-top:18px"><span class="field-label">Demo buy-in</span><input class="range" id="buyin-range" type="range" min="${limits.min}" max="${limits.max}" step="5" value="${state.buyInAmount}" aria-label="Demo buy-in amount" /><div class="quick-amounts"><button class="btn btn-small" data-action="set-buyin" data-value="${limits.min}">Min ${money(limits.min)}</button><button class="btn btn-small" data-action="set-buyin" data-value="${Math.round((limits.min + limits.max) / 2)}">Mid</button><button class="btn btn-small" data-action="set-buyin" data-value="${limits.max}">Max ${money(limits.max)}</button></div></div><div class="buyin-summary"><span><span>Demo stack</span><strong id="buyin-dollar">${money(state.buyInAmount)}</strong></span><span class="right"><span>Table label</span><strong id="buyin-token">${asset.symbol}</strong></span></div><div class="safety-box compact"><strong>No wallet spend</strong><span>The server records a preview seat and poker stack. It does not inspect or lock your real ${asset.symbol} balance.</span></div>`, footer: `<span class="balance-note">${state.profile ? `${moneyAtomic(state.profile.demoCreditAtomic)} demo credits` : "Identity required"}</span><button class="btn btn-primary" data-action="take-seat">${state.profile ? "Take demo seat" : "Connect & continue"}</button>` }));
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
function inviteModal() { if (!state.profile) { walletModal(); return; } openModal(modalShell({ eyebrow: "Private membership", title: "Join with an invite", description: "Codes look like ABCD-2345 and are matched by digest.", body: `<label class="field"><span class="field-label">Invite code</span><input class="input invite-input" id="invite-input" maxlength="9" placeholder="ABCD-2345" autocomplete="off" /></label>`, footer: `<span class="balance-note">Demo rooms only</span><button class="btn btn-primary" data-action="join-code">Join room</button>` })); }
async function joinInvite() { const button = document.querySelector('[data-action="join-code"]'); const code = document.querySelector("#invite-input").value; button.disabled = true; try { const result = await api("/v1/beta/rooms/join", { method: "POST", authenticated: true, body: { inviteCode: code } }); closeModal(); await loadLobby({ quiet: true }); toast(`Joined ${result.room.name}.`); } catch (error) { button.disabled = false; toast(error.message); } }

function buyStocksModal(asset = state.selectedAsset) { state.selectedAsset = asset; openModal(modalShell({ eyebrow: "Real asset boundary", title: `Get ${escapeHtml(asset.symbol)}`, description: "Real xStock purchase is intentionally outside the safe multiplayer beta.", body: `<div class="purchase-layout"><div><div class="field"><span class="field-label">Launch asset</span>${assetPicker(asset.symbol)}</div><div class="safety-box"><strong>Why this is paused</strong><span>A production in-app purchase needs xStocks integrator access, live quotes, jurisdiction screening, and a wallet-executed transaction. The beta does not fake any of those steps.</span></div></div><aside class="order-card"><span class="utility-label" style="color:#aebbb4">Current mode</span><div class="order-total">No quote</div><span class="quote-timer">Safe beta · transfers disabled</span><div class="order-row" style="margin-top:20px"><span>Wallet spend</span><strong>Disabled</strong></div><div class="order-row"><span>Table credits</span><strong>Simulated</strong></div><a class="btn btn-accent external-btn" href="https://xstocks.fi/" target="_blank" rel="noopener noreferrer">Visit xStocks ↗</a></aside></div>` })); }

async function takeSeat() {
  if (!state.profile) { closeModal(); walletModal("buyin"); return; }
  const button = document.querySelector('[data-action="take-seat"]'); button.disabled = true; button.textContent = "Seating…";
  if (state.backend !== "online") { closeModal(); state.tableId = "interface-preview"; state.tableState = previewTableState(); state.view = "table"; state.tableConnection = "preview"; render(); toast("Interface seat created locally. There is no multiplayer server on this deployment."); return; }
  try { const result = await api("/v1/beta/tables/join", { method: "POST", authenticated: true, body: { roomId: state.selectedRoom.id, assetSymbol: state.selectedAsset.symbol, buyInAtomic: String(Math.round(state.buyInAmount * 100)) } }); closeModal(); state.tableId = result.tableId; state.tableState = result.state; state.view = "table"; state.holeCards = []; render(); connectRealtime(); toast(`${money(state.buyInAmount)} in demo credits seated. No funds moved.`); }
  catch (error) { button.disabled = false; button.textContent = "Take demo seat"; toast(error.message); }
}

function previewTableState() { return { version: 1, status: "WAITING", tableId: "interface-preview", rules: state.selectedRoom.rules, seats: [{ playerId: state.profile?.wallet || "PreviewPlayer", seat: 3, stackAtomic: String(state.buyInAmount * 100), status: "SEATED", timeBankMs: 60_000 }], handNumber: 0, buttonSeat: null, currentHand: null, lastResult: null }; }
function seatName(player) { return player.playerId === state.profile?.wallet ? state.profile.displayName : shortWallet(player.playerId); }
function cardHtml(code, extra = "") { const red = /[♥♦]/.test(code) ? "red" : ""; return `<span class="card ${red} ${extra}">${escapeHtml(code)}</span>`; }
function tableSeat(seatNumber) {
  const player = state.tableState?.seats.find((candidate) => candidate.seat === seatNumber - 1); const handPlayer = state.tableState?.currentHand?.betting?.players.find((candidate) => candidate.seat === seatNumber - 1); const active = state.tableState?.currentHand?.turn?.playerId === player?.playerId; const isSelf = player?.playerId === state.profile?.wallet;
  if (!player) return `<div class="seat seat-${seatNumber} empty-seat"><span class="empty-seat-ring">＋</span><span class="player-name">Open seat</span></div>`;
  const initials = isSelf ? "YOU" : shortWallet(player.playerId).slice(0, 2).toUpperCase(); const cards = isSelf && state.holeCards.length ? `<span class="hero-cards">${state.holeCards.map((reveal) => cardHtml(reveal.card.code)).join("")}</span>` : "";
  return `<div class="seat seat-${seatNumber} ${active ? "active" : ""}">${cards}<span class="player-avatar" style="--avatar-color:${isSelf ? "#ddd5ff" : ["#ffd9a2", "#ccecff", "#ffc7c5", "#d7ff86", "#dfe5e0"][seatNumber % 5]}">${initials}${state.tableState.buttonSeat === player.seat ? '<span class="dealer-chip">D</span>' : ""}</span><span class="player-name">${escapeHtml(seatName(player))}</span><span class="player-stack">${moneyAtomic(handPlayer?.stack ?? player.stackAtomic)} · ${state.selectedAsset.symbol}</span>${handPlayer && handPlayer.streetContribution !== "0" ? `<span class="seat-bet">${moneyAtomic(handPlayer.streetContribution)}</span>` : ""}</div>`;
}

function fairnessRail() { const hand = state.tableState?.currentHand; const event = state.lastEvent; const completed = state.tableState?.lastResult?.handId; return `<aside class="fairness-rail"><div class="fairness-title"><span class="utility-label">Live hand tape</span><span class="connection-dot ${state.tableConnection}"></span></div><div class="tape-item"><span>Transport</span><strong>${escapeHtml(state.tableConnection)}</strong></div><div class="tape-item"><span>Table seq.</span><strong>${state.tableState?.version ?? 0}</strong></div><div class="tape-item"><span>Deck root</span><strong>${hand?.deckRoot ? `${hand.deckRoot.slice(0, 8)}…${hand.deckRoot.slice(-6)}` : "Waiting"}</strong></div><div class="tape-item"><span>Last event</span><strong>${escapeHtml(event?.type || "Snapshot ready")}</strong></div><div class="tape-note">Community cards include Merkle proofs. A complete post-hand audit is required before a hand is accepted.${completed ? `<button class="audit-link" data-action="view-audit" data-hand="${escapeHtml(completed)}">Verify last hand →</button>` : ""}</div></aside>`; }
function actionDock() {
  const current = state.tableState?.currentHand; const legal = current?.legalActions;
  if (!current) return `<div class="action-dock waiting-dock"><span><strong>Waiting for players</strong><small>At least two active seats are required before a hand can start.</small></span><button class="btn" data-action="copy-table">Copy table ID</button></div>`;
  if (!legal) return `<div class="action-dock waiting-dock"><span><strong>${current.turn ? `Action on ${escapeHtml(shortWallet(current.turn.playerId))}` : "Dealer resolving the street"}</strong><small>Live events will update this table automatically.</small></span><span class="tag">Hand ${state.tableState.handNumber}</span></div>`;
  const primary = legal.canCheck ? ["check", "Check"] : ["call", `Call ${moneyAtomic(legal.callAmount)}`]; const increase = legal.canRaise || legal.canBet; const min = Number(legal.minimumTarget || 0); const max = Number(legal.maximumTarget || min);
  return `<div class="action-dock"><button class="btn" data-action="table-action" data-poker="fold" ${legal.canFold ? "" : "disabled"}>Fold</button><button class="btn btn-primary" data-action="table-action" data-poker="${primary[0]}">${primary[1]}</button><div class="bet-control"><span>${legal.canBet ? "Bet to" : "Raise to"}</span><strong id="raise-value">${moneyAtomic(min)}</strong><input class="range" id="bet-range" type="range" min="${min}" max="${max}" value="${min}" step="1" ${increase ? "" : "disabled"} aria-label="Raise target" /><button class="range-submit" data-action="table-action" data-poker="${legal.canBet ? "bet" : "raise"}" ${increase ? "" : "disabled"}>Send</button></div></div>`;
}

function tableView() {
  const room = state.selectedRoom; const table = state.tableState || previewTableState(); const hand = table.currentHand; const board = hand?.publicReveals?.map((reveal) => reveal.card.code) || []; const potAtomic = hand?.betting?.players?.reduce((sum, player) => sum + Number(player.contributed), 0) || 0; const tableMessage = table.status === "WAITING" ? table.seats.length < 2 ? `${table.seats.length}/${table.rules.seats} seated · waiting for a second player` : `${table.seats.length}/${table.rules.seats} seated · dealer preparing the next fair hand` : hand?.turn ? `Action is on ${shortWallet(hand.turn.playerId)}` : "Dealer is resolving the hand";
  return `<main class="table-page"><header class="table-bar"><div class="table-title"><button class="icon-btn" data-action="leave-table" aria-label="Leave table">←</button><div><h1>${escapeHtml(room.name)}</h1><span>${gameLabel(hand?.game || room.game)} · ${moneyAtomic(room.rules.smallBlindAtomic)} / ${moneyAtomic(room.rules.bigBlindAtomic)}</span></div></div><div class="table-meta"><span class="tag">Hand #${table.handNumber}</span><span class="tag">Seq ${table.version}</span><span class="tag">${state.selectedAsset.symbol} demo</span><span class="status-pill"><i class="market-dot"></i>No funds</span></div></header><section class="poker-stage"><div class="table-toast">${escapeHtml(tableMessage)}</div>${fairnessRail()}<div class="table-wrap"><div class="poker-table"><div class="pot-center"><span class="utility-label">Demo pot</span><strong>${moneyAtomic(potAtomic)} · ${state.selectedAsset.symbol}</strong><div class="board-cards">${Array.from({ length: 5 }, (_, index) => board[index] ? cardHtml(board[index]) : cardHtml("?", "face-down")).join("")}</div></div></div>${Array.from({ length: Math.min(table.rules.seats, 6) }, (_, index) => tableSeat(index + 1)).join("")}</div>${actionDock()}</section></main>`;
}

function render() { document.querySelector("#app").innerHTML = state.loading ? `<div class="app-loading"><span class="brand-mark">xP</span><strong>Opening the safe floor…</strong></div>` : state.view === "table" ? tableView() : lobbyView(); bindEvents(); }
function requestId(prefix = "web") { return `${prefix}:${crypto.randomUUID()}`; }
function sendRealtime(message) { if (state.socket?.readyState !== WebSocket.OPEN) { toast("Realtime connection is not ready yet."); return false; } state.socket.send(JSON.stringify(message)); return true; }
function wsOrigin() { return API_ORIGIN.replace(/^http/, "ws"); }

function connectRealtime() {
  clearTimeout(state.reconnectTimer); if (!state.tableId || !state.token || !API_ORIGIN || state.view !== "table") return;
  state.socket?.close(1000, "replace connection"); state.tableConnection = "connecting"; render(); const socket = new WebSocket(`${wsOrigin()}/v1/realtime`, "xpoker.v1"); state.socket = socket;
  socket.addEventListener("open", () => { state.tableConnection = "authenticating"; sendRealtime({ type: "authenticate", requestId: requestId("auth"), token: state.token }); render(); });
  socket.addEventListener("message", async (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "authenticated") { state.tableConnection = "live"; state.reconnectAttempt = 0; sendRealtime({ type: "subscribe", requestId: requestId("sub"), tableId: state.tableId, afterVersion: state.tableState?.version || 0 }); await beginHoleKeyExchange(); render(); }
    if (message.type === "table_snapshot") { state.tableState = message.state; render(); }
    if (message.type === "command_result") {
      state.tableState = message.state;
      if (message.requestId === state.leaveRequestId) { await completeTableLeave(); return; }
      render();
    }
    if (message.type === "table_event") { state.lastEvent = message.event; sendRealtime({ type: "subscribe", requestId: requestId("sync"), tableId: state.tableId, afterVersion: state.tableState?.version || 0 }); }
    if (message.type === "hole_card_key_established") await completeHoleKeyExchange(message.serverPublicKey);
    if (message.type === "hole_cards") { try { const payload = await decryptHoleCards(message.envelope); state.holeCards = payload.reveals; render(); } catch { toast("Private cards could not be decrypted. Reconnecting safely."); socket.close(4400, "private deal decrypt failed"); } }
    if (message.type === "error") toast(message.message || "Realtime command failed.");
  });
  socket.addEventListener("close", (event) => { if (state.socket !== socket) return; state.tableConnection = event.code === 1000 ? "offline" : "reconnecting"; render(); if (state.view === "table" && event.code !== 1000) { const delay = Math.min(10_000, 500 * (2 ** state.reconnectAttempt)); state.reconnectAttempt += 1; state.reconnectTimer = setTimeout(connectRealtime, delay); } });
  socket.addEventListener("error", () => { state.tableConnection = "reconnecting"; render(); });
}

async function beginHoleKeyExchange() {
  if (!crypto.subtle || !state.profile) return;
  try { const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]); const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)); state.holeKey = { pair, aesKey: null }; sendRealtime({ type: "key_exchange", requestId: requestId("key"), clientPublicKey: bytesToBase64Url(rawPublic) }); }
  catch { toast("This browser cannot open encrypted private cards (X25519 unavailable). Public play state remains connected."); }
}

function base64UrlToBytes(value) { const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4); const binary = atob(base64); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
async function completeHoleKeyExchange(serverPublicKey) { const serverKey = await crypto.subtle.importKey("raw", base64UrlToBytes(serverPublicKey), { name: "X25519" }, false, []); const shared = await crypto.subtle.deriveBits({ name: "X25519", public: serverKey }, state.holeKey.pair.privateKey, 256); const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]); const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`xpoker-hole-cards/v1:${state.profile.wallet}`)); state.holeKey.aesKey = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("xpoker-hole-cards/v1") }, hkdfKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]); }
async function decryptHoleCards(envelope) { if (!state.holeKey?.aesKey) throw new Error("Private-card key is unavailable"); const { iv, ciphertext, tag, ...aad } = envelope; const cipher = base64UrlToBytes(ciphertext); const authTag = base64UrlToBytes(tag); const combined = new Uint8Array(cipher.length + authTag.length); combined.set(cipher); combined.set(authTag, cipher.length); const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: new TextEncoder().encode(canonicalJson(aad)), tagLength: 128 }, state.holeKey.aesKey, combined); return JSON.parse(new TextDecoder().decode(plaintext)); }

function tableAction(type) { const hand = state.tableState?.currentHand; if (!hand?.legalActions) return; const action = { type }; if (type === "raise" || type === "bet") action.to = document.querySelector("#bet-range").value; sendRealtime({ type: "command", command: "act", requestId: requestId("act"), tableId: state.tableId, expectedVersion: state.tableState.version, expectedBettingVersion: hand.betting.version, idempotencyKey: requestId("idem"), action }); }
async function completeTableLeave() { state.leaveRequestId = null; state.socket?.close(1000, "left table"); state.tableId = null; state.tableState = null; state.holeCards = []; state.lastEvent = null; state.view = "lobby"; await loadLobby({ quiet: true }); toast("Demo seat released. No funds moved."); }
function leaveTable() {
  if (!state.tableId || state.tableId === "interface-preview" || state.tableConnection !== "live") { completeTableLeave(); return; }
  if (state.leaveRequestId) return;
  const id = requestId("leave"); state.leaveRequestId = id;
  if (!sendRealtime({ type: "command", command: "leave", requestId: id, tableId: state.tableId, expectedVersion: state.tableState.version, idempotencyKey: requestId("idem") })) state.leaveRequestId = null;
}
async function logout() { try { if (state.token && state.backend === "online") await api("/v1/auth/logout", { method: "POST", authenticated: true, body: {} }); } catch {} sessionStorage.removeItem(SESSION_KEY); state.token = null; state.profile = null; state.socket?.close(1000, "logout"); closeModal(); await loadLobby({ quiet: true }); toast("Beta session ended."); }
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
      body: `<div class="audit-grid"><div><span>Deck root</span><strong>${escapeHtml(record.deckRoot)}</strong></div><div><span>Rules hash</span><strong>${escapeHtml(record.rulesHash)}</strong></div><div><span>drand round</span><strong>${record.beacon.round}</strong></div><div><span>Transcript head</span><strong>${escapeHtml(result.transcriptHead)}</strong></div></div><div class="safety-box"><strong>What this proves</strong><span>The revealed seeds reconstruct the committed 52-card deck, the external beacon matches the reserved signed round, and the signed transcript head binds the lifecycle.</span></div>`,
      footer: `<span class="status-pill"><i class="market-dot"></i>Beacon verified</span><button class="btn" data-action="copy-audit">Copy audit JSON</button>`,
    }));
  } catch (error) { toast(error.message); }
}
function toast(message) { const root = document.querySelector("#toast-root"); const element = document.createElement("div"); element.className = "toast"; element.textContent = message; root.appendChild(element); setTimeout(() => element.remove(), 4_200); }

function bindEvents(root = document) {
  root.querySelectorAll("[data-action]").forEach((element) => { if (element.dataset.bound) return; element.dataset.bound = "true"; element.addEventListener("click", handleAction); if (element.classList.contains("room-card")) element.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); element.click(); } }); });
  root.querySelector("#buyin-range")?.addEventListener("input", (event) => { state.buyInAmount = Number(event.target.value); document.querySelector("#buyin-dollar").textContent = money(state.buyInAmount); });
  root.querySelector("#bet-range")?.addEventListener("input", (event) => { document.querySelector("#raise-value").textContent = moneyAtomic(event.target.value); });
}

function handleAction(event) {
  const target = event.currentTarget; const action = target.dataset.action;
  if (action === "close-modal") { if (!target.classList.contains("modal-overlay") || event.target === target) closeModal(); }
  if (action === "go-lobby") { event.preventDefault(); state.socket?.close(1000, "left table view"); state.view = "lobby"; closeModal(); loadLobby({ quiet: true }); }
  if (action === "leave-table") { event.preventDefault(); leaveTable(); }
  if (action === "open-wallet") walletModal(); if (action === "connect-provider") connectProvider(target); if (action === "guest-session") createGuestSession(); if (action === "preview-session") createPreviewSession(); if (action === "logout") logout();
  if (action === "open-host") hostModal(); if (action === "open-invite") inviteModal(); if (action === "join-code") joinInvite();
  if (action === "focus-bankroll") document.querySelector("#bankroll")?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (action === "open-buy") buyStocksModal(); if (action === "asset-info") buyStocksModal(state.assets.find((asset) => asset.symbol === target.dataset.symbol));
  if (action === "open-buyin") buyinModal(state.rooms.find((room) => room.id === target.dataset.room)); if (action === "quick-seat") buyinModal(state.rooms.find((room) => room.visibility === "public" && Number(room.seatsTaken) < room.rules.seats) || state.rooms[0]);
  if (action === "select-asset") { state.selectedAsset = state.assets.find((asset) => asset.symbol === target.dataset.symbol); if (document.querySelector("#buyin-range")) buyinModal(state.selectedRoom); else buyStocksModal(state.selectedAsset); }
  if (action === "set-buyin") { state.buyInAmount = Number(target.dataset.value); document.querySelector("#buyin-range").value = state.buyInAmount; document.querySelector("#buyin-dollar").textContent = money(state.buyInAmount); }
  if (action === "take-seat") takeSeat(); if (action === "host-game") { state.hostGame = target.dataset.value; target.parentElement.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === target)); }
  if (action === "create-room") createRoom(); if (action === "copy-code") { navigator.clipboard?.writeText(target.dataset.code); toast("Invite code copied."); }
  if (action === "open-created-room") { const room = state.rooms.find((item) => item.id === target.dataset.room); closeModal(); buyinModal(room); }
  if (action === "table-action") tableAction(target.dataset.poker); if (action === "copy-table") { navigator.clipboard?.writeText(state.tableId); toast("Table ID copied."); }
  if (action === "view-audit") viewAudit(target.dataset.hand); if (action === "copy-audit") { navigator.clipboard?.writeText(JSON.stringify(state.audit, null, 2)); toast("Audit bundle copied."); }
}

document.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.querySelector(".modal-overlay")) closeModal(); });
render();
loadLobby();
