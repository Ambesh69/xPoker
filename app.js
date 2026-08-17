const ASSETS = [
  { symbol: "AAPLx", short: "AA", name: "Apple", color: "#dfe5e0", price: 228.4, move: "+0.8%", balance: 0.42 },
  { symbol: "NVDAx", short: "NV", name: "NVIDIA", color: "#c9f6a5", price: 182.7, move: "+2.4%", balance: 0.61 },
  { symbol: "MSFTx", short: "MS", name: "Microsoft", color: "#ccecff", price: 512.2, move: "+0.5%", balance: 0.18 },
  { symbol: "AMZNx", short: "AZ", name: "Amazon", color: "#ffd9a2", price: 235.6, move: "+1.2%", balance: 0.38 },
  { symbol: "GOOGLx", short: "GO", name: "Alphabet", color: "#ffeaa4", price: 209.3, move: "+0.4%", balance: 0.22 },
  { symbol: "METAx", short: "ME", name: "Meta", color: "#d8dcff", price: 694.1, move: "+1.8%", balance: 0.09 },
  { symbol: "TSLAx", short: "TS", name: "Tesla", color: "#ffc7c5", price: 368.8, move: "−0.6%", balance: 0.17 },
  { symbol: "NFLXx", short: "NF", name: "Netflix", color: "#f6c9dc", price: 121.5, move: "+0.7%", balance: 0.3 },
  { symbol: "SPYx", short: "SP", name: "S&P 500 ETF", color: "#d7ff86", price: 641.2, move: "+0.6%", balance: 0.14 },
  { symbol: "QQQx", short: "QQ", name: "Nasdaq 100 ETF", color: "#ddd5ff", price: 572.8, move: "+0.9%", balance: 0.16 },
];

const PUBLIC_ROOMS = [
  { id: "bell", name: "Opening Bell", game: "NLH", blinds: "$0.10 / $0.20", min: 20, max: 100, players: 5, seats: 6, accent: "#d7ff86", rake: "2.5% · 2 BB cap" },
  { id: "four", name: "Four Cards", game: "PLO 4", blinds: "$0.10 / $0.20", min: 20, max: 120, players: 4, seats: 6, accent: "#ccecff", rake: "2.5% · 2 BB cap" },
  { id: "rotation-a", name: "Market Mix I", game: "ROE", blinds: "$0.10 / $0.20", min: 20, max: 150, players: 6, seats: 6, accent: "#ddd5ff", rake: "2.5% · 2 BB cap" },
  { id: "rotation-b", name: "Market Mix II", game: "ROE", blinds: "$0.10 / $0.20", min: 20, max: 150, players: 3, seats: 6, accent: "#ffc7c5", rake: "2.5% · 2 BB cap" },
];

const INITIAL_PRIVATE_ROOMS = [
  { id: "priv-1", name: "Sunday Syndicate", game: "ROE", blinds: "$0.25 / $0.50", players: 5, seats: 8, code: "SUNDAY8", min: 40, max: 300, rake: 1.5 },
  { id: "priv-2", name: "After Hours", game: "PLO 4", blinds: "$0.10 / $0.20", players: 2, seats: 6, code: "NIGHT42", min: 20, max: 200, rake: 2 },
];

const state = {
  view: "lobby",
  walletConnected: false,
  walletAddress: "7kR4…x92F",
  selectedRoom: PUBLIC_ROOMS[2],
  selectedAsset: ASSETS[0],
  buyInAmount: 40,
  purchaseAmount: 50,
  privateRooms: loadRooms(),
  hostGame: "NLH",
};

function loadRooms() {
  try {
    const saved = JSON.parse(localStorage.getItem("xpoker-private-rooms"));
    return Array.isArray(saved) && saved.length ? saved : INITIAL_PRIVATE_ROOMS;
  } catch {
    return INITIAL_PRIVATE_ROOMS;
  }
}

function saveRooms() {
  localStorage.setItem("xpoker-private-rooms", JSON.stringify(state.privateRooms));
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function assetLogo(asset) {
  return `<span class="asset-logo" style="--asset-color:${asset.color}" title="${asset.name}">${asset.short}</span>`;
}

function navItem(icon, label, action, active = false) {
  return `<button class="nav-item ${active ? "active" : ""}" data-action="${action}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`;
}

function sidebar() {
  return `
    <aside class="sidebar">
      <a class="brand" href="#" data-action="go-lobby" aria-label="xPoker home">
        <span class="brand-mark">xP</span><span class="brand-word">xPoker</span>
      </a>
      <div class="nav-label">Game floor</div>
      <nav class="nav-list" aria-label="Primary navigation">
        ${navItem("⌁", "Tables", "go-lobby", true)}
        ${navItem("＋", "Host room", "open-host")}
        ${navItem("↗", "Activity", "show-activity")}
        ${navItem("◫", "Bankroll", "focus-bankroll")}
      </nav>
      <div class="sidebar-card">
        <div class="mini-row"><span class="utility-label">Network</span><span class="status-pill"><i class="market-dot"></i>Solana</span></div>
        <strong>Markets never fold.</strong>
        <p>xStocks can move 24/7. Public price references are indicative in this prototype.</p>
      </div>
    </aside>`;
}

function topbar(title = "Public tables") {
  return `
    <header class="topbar">
      <div class="crumbs"><span>Game floor</span><span>／</span><strong>${title}</strong></div>
      <div class="top-actions">
        <span class="quote-status"><i class="market-dot"></i>Preview · no funds move</span>
        <button class="btn btn-ghost btn-small" data-action="open-buy">Buy xStocks</button>
        <button class="btn ${state.walletConnected ? "" : "btn-primary"} wallet-btn" data-action="open-wallet">
          ${state.walletConnected ? `<span class="wallet-avatar">xP</span>${state.walletAddress}` : "Connect wallet"}
        </button>
      </div>
    </header>`;
}

function marketRail() {
  return `
    <section class="market-rail" aria-label="Eligible buy-in assets">
      <div class="rail-intro"><strong>Core 10</strong><span>Eligible for buy-ins</span></div>
      <div class="asset-strip">
        ${ASSETS.map((asset) => `
          <button class="asset-quote" data-action="asset-buy" data-symbol="${asset.symbol}" aria-label="Buy ${asset.name} xStock">
            ${assetLogo(asset)}
            <span class="asset-meta"><strong>${asset.symbol}</strong><small>${asset.move}</small></span>
          </button>`).join("")}
      </div>
    </section>`;
}

function roomCard(room, index) {
  const avatarColors = ["#ccecff", "#ddd5ff", "#ffd9a2", "#d7ff86"];
  return `
    <article class="room-card" style="--room-accent:${room.accent}" data-action="open-buyin" data-room="${room.id}" tabindex="0" aria-label="Join ${room.name}">
      <div class="room-top"><span class="game-pill">${room.game === "ROE" ? "NLH ↔ PLO 4" : room.game}</span><span class="status-pill"><i class="market-dot"></i>Preview</span></div>
      <h3>${room.name}</h3>
      <span class="blinds">${room.blinds} · 6 max</span>
      <div class="room-stats">
        <div class="room-stat"><span>Buy-in</span><strong>${money(room.min)}–${money(room.max)}</strong></div>
        <div class="room-stat"><span>Rake</span><strong>${room.rake.split(" · ")[0]}</strong></div>
      </div>
      <div class="room-footer">
        <div class="avatar-stack">
          ${Array.from({ length: Math.min(room.players, 4) }, (_, i) => `<span class="avatar" style="--avatar-color:${avatarColors[(i + index) % avatarColors.length]}">${["LM", "AK", "RZ", "JS"][i]}</span>`).join("")}
        </div>
        <span class="seat-count">${room.players}/${room.seats} seated →</span>
      </div>
    </article>`;
}

function privatePanel() {
  return `
    <section class="private-panel">
      <div class="section-head">
        <div><h2>Your private rooms</h2><p>Invite-only tables with host-controlled rules.</p></div>
        <button class="btn btn-small" data-action="open-host">＋ New room</button>
      </div>
      <div class="private-list">
        ${state.privateRooms.map((room, i) => `
          <div class="private-room">
            <span class="private-icon" style="background:${i % 2 ? "#ccecff" : "#ddd5ff"}">${room.game === "PLO 4" ? "4c" : room.game === "ROE" ? "↻" : "2c"}</span>
            <span class="private-copy"><strong>${room.name}</strong><span>${room.game} · ${room.blinds} · ${room.players}/${room.seats} seated</span></span>
            <span class="private-code">${room.code}</span>
            <button class="btn btn-small" data-action="join-private" data-room="${room.id}">Open</button>
          </div>`).join("")}
      </div>
    </section>`;
}

function bankrollPanel() {
  const holdings = ASSETS.filter((asset) => asset.balance > 0).slice(0, 3);
  const total = holdings.reduce((sum, asset) => sum + asset.balance * asset.price, 0);
  return `
    <aside class="bankroll-panel" id="bankroll">
      <div class="bankroll-head">
        <span class="utility-label">Playable balance</span>
        <div class="balance">${state.walletConnected ? money(total) : "$0.00"}</div>
        <span class="balance-note">${state.walletConnected ? "Across 10 eligible xStocks" : "Connect a self-custody wallet"}</span>
      </div>
      <div class="bankroll-body">
        ${state.walletConnected ? `
          ${holdings.map((asset) => `
            <div class="holding">${assetLogo(asset)}<span><strong>${asset.symbol}</strong><span>${asset.balance.toFixed(3)} tokens</span></span><span class="holding-value"><strong>${money(asset.balance * asset.price)}</strong><span>available</span></span></div>
          `).join("")}
          <div class="bankroll-actions"><button class="btn btn-small" data-action="open-buy">Buy more</button><button class="btn btn-small btn-accent" data-action="quick-seat">Quick seat</button></div>
        ` : `
          <div class="empty-balance"><span class="empty-orbit">xStocks</span><strong>Your portfolio is your stack.</strong><p>Connect to see eligible holdings and take a seat without depositing to a platform account.</p><button class="btn btn-primary" data-action="open-wallet">Connect wallet</button></div>
        `}
      </div>
    </aside>`;
}

function lobbyView() {
  return `
    <div class="app-shell">
      ${sidebar()}
      <main class="page">
        ${topbar()}
        <div class="content">
          <section class="hero">
            <div>
              <span class="eyebrow">Poker, settled in xStocks</span>
              <h1>Play the <em>market.</em></h1>
              <p class="hero-copy">No chips to top up. Choose an eligible xStock, lock its dollar value when you sit, and play NLH, PLO 4, or round-of-each.</p>
            </div>
            <div class="hero-actions"><button class="btn btn-primary" data-action="quick-seat">Find a seat</button><button class="btn" data-action="open-host">Host private room</button></div>
          </section>
          ${marketRail()}
          <section>
            <div class="section-head"><div><h2>The public floor</h2><p>Four permanent tables. Every seat starts from $20.</p></div><span class="tag">Cash games · 6 max</span></div>
            <div class="public-grid">${PUBLIC_ROOMS.map(roomCard).join("")}</div>
          </section>
          <div class="dashboard-row">${privatePanel()}${bankrollPanel()}</div>
        </div>
      </main>
    </div>`;
}

function tableView() {
  const room = state.selectedRoom;
  return `
    <main class="table-page">
      <header class="table-bar">
        <div class="table-title">
          <button class="icon-btn" data-action="go-lobby" aria-label="Back to tables">←</button>
          <div><h1>${room.name}</h1><span>${room.game === "ROE" ? "Round of each · NLH now" : room.game} · ${room.blinds}</span></div>
        </div>
        <div class="table-meta"><span class="tag">Hand #1842</span><span class="tag">${room.rake}</span><button class="btn btn-small" data-action="open-buy">＋ xStocks</button></div>
      </header>
      <section class="poker-stage">
        <div class="table-toast">${room.game === "ROE" ? "PLO 4 begins after this orbit" : "Action is on RiverLi"}</div>
        <div class="table-wrap">
          <div class="poker-table">
            <div class="pot-center"><span class="utility-label">Pot</span><strong>$7.20 · AAPLx</strong><div class="board-cards"><span class="card">2♠</span><span class="card">6♠</span><span class="card">2♣</span><span class="card red">Q♥</span><span class="card face-down">?</span></div></div>
          </div>
          <div class="seat seat-1"><span class="player-avatar" style="--avatar-color:#ffd9a2">AK<span class="dealer-chip">D</span></span><span class="player-name">antking</span><span class="player-stack">$84.30 · NVDAx</span></div>
          <div class="seat seat-2"><span class="player-avatar" style="--avatar-color:#ccecff">RZ</span><span class="player-name">riz</span><span class="player-stack">$61.10 · SPYx</span></div>
          <div class="seat seat-3"><span class="player-avatar" style="--avatar-color:#ffc7c5">ML</span><span class="player-name">mellow</span><span class="player-stack">$104.82 · TSLAx</span></div>
          <div class="seat seat-4"><span class="hero-cards"><span class="card red">A♦</span><span class="card red">2♥</span></span><span class="player-avatar" style="--avatar-color:#ddd5ff">YOU</span><span class="player-name">${state.walletAddress}</span><span class="player-stack">${money(state.buyInAmount)} · ${state.selectedAsset.symbol}</span></div>
          <div class="seat seat-5 active"><span class="player-avatar" style="--avatar-color:#d7ff86">RL</span><span class="player-name">RiverLi</span><span class="player-stack">$118.20 · AAPLx</span></div>
          <div class="seat seat-6"><span class="player-avatar" style="--avatar-color:#dfe5e0">HW</span><span class="player-name">hours</span><span class="player-stack">$79.45 · QQQx</span></div>
          <span class="bet-chip bet-1">$2.20</span><span class="bet-chip bet-2">$2.20</span><span class="bet-chip bet-5">$2.80</span>
        </div>
        <div class="action-dock">
          <button class="btn" data-action="poker-action" data-name="Folded">Fold</button>
          <button class="btn" data-action="poker-action" data-name="Called $2.80">Call $2.80</button>
          <div class="bet-control"><span>Raise</span><strong id="raise-value">$8.40</strong><input class="range" id="bet-range" type="range" min="6" max="40" value="8.4" step="0.2" aria-label="Raise amount" /></div>
        </div>
      </section>
    </main>`;
}

function render() {
  document.querySelector("#app").innerHTML = state.view === "table" ? tableView() : lobbyView();
  bindEvents();
}

function modalShell({ eyebrow, title, description = "", body, footer = "", wide = false }) {
  return `
    <div class="modal-overlay" data-action="close-modal">
      <section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel>
        <header class="modal-head"><div><span class="eyebrow">${eyebrow}</span><h2 id="modal-title">${title}</h2>${description ? `<p>${description}</p>` : ""}</div><button class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-foot">${footer}</footer>` : ""}
      </section>
    </div>`;
}

function openModal(html) {
  document.querySelector("#modal-root").innerHTML = html;
  document.body.style.overflow = "hidden";
  bindEvents(document.querySelector("#modal-root"));
  setTimeout(() => document.querySelector(".modal button, .modal input")?.focus(), 0);
}

function closeModal() {
  document.querySelector("#modal-root").innerHTML = "";
  document.body.style.overflow = "";
}

function walletModal(afterConnect = null) {
  openModal(modalShell({
    eyebrow: "Self-custody",
    title: "Connect your wallet",
    description: "We only read eligible xStock balances until you approve a buy-in.",
    body: `
      <div class="provider-list">
        <button class="provider" data-action="connect-provider" data-provider="Phantom" data-after="${afterConnect || ""}"><span class="provider-logo">PH</span><span><strong>Phantom</strong><span>Best for Solana xStocks</span></span><small>Recommended</small></button>
        <button class="provider" data-action="connect-provider" data-provider="Backpack" data-after="${afterConnect || ""}"><span class="provider-logo">BP</span><span><strong>Backpack</strong><span>Solana and EVM</span></span><small>Installed</small></button>
        <button class="provider" data-action="connect-provider" data-provider="WalletConnect" data-after="${afterConnect || ""}"><span class="provider-logo">WC</span><span><strong>WalletConnect</strong><span>Connect another wallet</span></span><small>QR / mobile</small></button>
      </div>
      <p class="legal-note">Prototype connection: no real wallet request is sent. Production should verify the token mint, chain, adjusted balance multiplier, jurisdiction, and signed ownership proof before enabling a seat.</p>`,
  }));
}

function connectProvider(button) {
  const provider = button.dataset.provider;
  const after = button.dataset.after;
  button.disabled = true;
  button.querySelector("small").textContent = "Connecting…";
  setTimeout(() => {
    state.walletConnected = true;
    closeModal();
    render();
    toast(`${provider} connected. Eligible holdings are ready.`);
    if (after === "buyin") buyinModal(state.selectedRoom);
    if (after === "buy") buyStocksModal();
  }, 700);
}

function assetPicker(selectedSymbol, action = "select-asset") {
  return `<div class="asset-picker">${ASSETS.map((asset) => `<button class="asset-option ${asset.symbol === selectedSymbol ? "selected" : ""}" data-action="${action}" data-symbol="${asset.symbol}">${assetLogo(asset)}<strong>${asset.symbol}</strong></button>`).join("")}</div>`;
}

function buyinModal(room) {
  state.selectedRoom = room;
  state.buyInAmount = Math.max(room.min, Math.min(state.buyInAmount, room.max));
  const asset = state.selectedAsset;
  const quantity = (state.buyInAmount / asset.price).toFixed(4);
  openModal(modalShell({
    eyebrow: `${room.game} · ${room.blinds}`,
    title: `Sit at ${room.name}`,
    description: `Dollar value locks when you take a seat. Min ${money(room.min)} · Max ${money(room.max)}.`,
    body: `
      <div class="field"><span class="field-label">Choose buy-in asset</span>${assetPicker(asset.symbol)}</div>
      <div class="field" style="margin-top:18px"><span class="field-label">Buy-in value</span><input class="range" id="buyin-range" type="range" min="${room.min}" max="${room.max}" step="5" value="${state.buyInAmount}" aria-label="Buy-in amount" /><div class="quick-amounts"><button class="btn btn-small" data-action="set-buyin" data-value="${room.min}">Min ${money(room.min)}</button><button class="btn btn-small" data-action="set-buyin" data-value="${Math.round((room.min + room.max) / 2)}">Mid</button><button class="btn btn-small" data-action="set-buyin" data-value="${room.max}">Max ${money(room.max)}</button></div></div>
      <div class="buyin-summary"><span><span>Seat value</span><strong id="buyin-dollar">${money(state.buyInAmount)}</strong></span><span class="right"><span>You lock</span><strong id="buyin-token">${quantity} ${asset.symbol}</strong></span></div>
      <p class="legal-note">At the table, stacks are shown in dollars. Settlement returns the same xStock quantity adjusted for net play, not the asset's later dollar price.</p>`,
    footer: `<span class="balance-note">${state.walletConnected ? `${asset.balance.toFixed(3)} ${asset.symbol} in wallet` : "Wallet not connected"}</span><button class="btn btn-primary" data-action="take-seat">${state.walletConnected ? "Lock buy-in & take seat" : "Connect & continue"}</button>`,
  }));
}

function updateBuyinDisplay() {
  const asset = state.selectedAsset;
  const dollar = document.querySelector("#buyin-dollar");
  const token = document.querySelector("#buyin-token");
  const range = document.querySelector("#buyin-range");
  if (range) range.value = state.buyInAmount;
  if (dollar) dollar.textContent = money(state.buyInAmount);
  if (token) token.textContent = `${(state.buyInAmount / asset.price).toFixed(4)} ${asset.symbol}`;
}

function hostModal() {
  openModal(modalShell({
    wide: true,
    eyebrow: "Private table",
    title: "Set your house rules",
    description: "Launch an invite-only cash table and keep it running when you leave.",
    body: `
      <form id="host-form">
        <div class="form-grid">
          <label class="field field-full"><span class="field-label">Room name</span><input class="input" name="name" value="Friday Allocation" maxlength="32" required /></label>
          <div class="field field-full"><span class="field-label">Game</span><div class="segmented"><button type="button" class="segment ${state.hostGame === "NLH" ? "active" : ""}" data-action="host-game" data-value="NLH">NLH</button><button type="button" class="segment ${state.hostGame === "PLO 4" ? "active" : ""}" data-action="host-game" data-value="PLO 4">PLO 4</button><button type="button" class="segment ${state.hostGame === "ROE" ? "active" : ""}" data-action="host-game" data-value="ROE">Round of each</button></div></div>
          <label class="field"><span class="field-label">Small / big blind</span><select class="select" name="blinds"><option>$0.05 / $0.10</option><option selected>$0.10 / $0.20</option><option>$0.25 / $0.50</option><option>$0.50 / $1.00</option><option>$1.00 / $2.00</option></select></label>
          <label class="field"><span class="field-label">Seats</span><select class="select" name="seats"><option>2</option><option>4</option><option selected>6</option><option>8</option><option>9</option></select></label>
          <label class="field"><span class="field-label">Minimum buy-in ($)</span><input class="input" name="min" type="number" min="5" step="5" value="20" required /></label>
          <label class="field"><span class="field-label">Maximum buy-in ($)</span><input class="input" name="max" type="number" min="20" step="10" value="200" required /></label>
          <label class="field"><span class="field-label">Rake</span><select class="select" name="rake"><option value="0">No rake</option><option value="1">1%</option><option value="1.5">1.5%</option><option value="2" selected>2%</option><option value="2.5">2.5%</option><option value="3">3%</option><option value="4">4%</option><option value="5">5%</option></select></label>
          <label class="field"><span class="field-label">Rake cap</span><select class="select" name="cap"><option>1 BB</option><option selected>2 BB</option><option>3 BB</option><option>5 BB</option><option>No cap</option></select></label>
          <label class="field"><span class="field-label">Action clock</span><select class="select" name="clock"><option>15 seconds</option><option selected>20 seconds</option><option>30 seconds</option><option>45 seconds</option></select></label>
          <label class="field"><span class="field-label">Time bank</span><select class="select" name="timebank"><option>30 seconds</option><option selected>60 seconds</option><option>90 seconds</option><option>120 seconds</option></select></label>
          <div class="field field-full"><span class="field-label">Table rules</span><div class="rule-grid">
            ${toggle("Run it twice", "When every all-in player agrees", true, "rit")}
            ${toggle("UTG straddle", "2× big blind", true, "straddle")}
            ${toggle("Host approves buy-ins", "Review seats and rebuys", true, "approval")}
            ${toggle("Waiting list", "First approved, first seated", true, "queue")}
            ${toggle("Rabbit hunt", "Reveal undealt board cards", false, "rabbit")}
            ${toggle("Anonymous until seated", "Hide wallet and handle", false, "anon")}
          </div></div>
        </div>
      </form>`,
    footer: `<span class="balance-note">Invite code generated on launch</span><button class="btn btn-primary" data-action="create-room">Create private room</button>`,
  }));
}

function toggle(title, description, on, key) {
  return `<div class="toggle-row"><span><strong>${title}</strong><span>${description}</span></span><button type="button" class="switch ${on ? "on" : ""}" data-action="toggle" data-key="${key}" aria-label="Toggle ${title}" aria-pressed="${on}"></button></div>`;
}

function createRoom() {
  const form = document.querySelector("#host-form");
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const min = Number(data.get("min"));
  const max = Number(data.get("max"));
  if (max < min) {
    toast("Maximum buy-in must be above the minimum.");
    return;
  }
  const room = {
    id: `priv-${Date.now()}`,
    name: data.get("name"),
    game: state.hostGame,
    blinds: data.get("blinds"),
    seats: Number(data.get("seats")),
    players: 0,
    min,
    max,
    rake: Number(data.get("rake")),
    code: Math.random().toString(36).slice(2, 8).toUpperCase(),
  };
  state.privateRooms.unshift(room);
  saveRooms();
  closeModal();
  render();
  toast(`${room.name} is ready in preview. Invite code: ${room.code}`);
}

function buyStocksModal() {
  const asset = state.selectedAsset;
  const quantity = (state.purchaseAmount / asset.price).toFixed(4);
  openModal(modalShell({
    wide: true,
    eyebrow: "One-tap xStock",
    title: `Buy ${asset.symbol} without leaving the table`,
    description: "Indicative RFQ preview. The final quote is signed and settled atomically onchain.",
    body: `
      <div class="purchase-layout">
        <div>
          <div class="field"><span class="field-label">Choose asset</span>${assetPicker(asset.symbol, "select-buy-asset")}</div>
          <label class="field" style="margin-top:18px"><span class="field-label">Pay with USDC</span><input class="input" id="purchase-input" type="number" min="5" step="5" value="${state.purchaseAmount}" /></label>
          <div class="quick-amounts"><button class="btn btn-small" data-action="set-purchase" data-value="20">$20</button><button class="btn btn-small" data-action="set-purchase" data-value="50">$50</button><button class="btn btn-small" data-action="set-purchase" data-value="100">$100</button></div>
          <p class="legal-note">Live launch requires xStocks integrator onboarding and jurisdiction screening. xStocks are not available in every country, including the U.S., U.K., Canada, and Australia.</p>
        </div>
        <aside class="order-card">
          <span class="utility-label" style="color:#aebbb4">RFQ preview</span><div class="order-total" id="order-total">${quantity} ${asset.symbol}</div><span class="quote-timer">Indicative · refreshes on review</span>
          <div style="margin-top:18px"><div class="order-row"><span>You pay</span><strong id="order-pay">${money(state.purchaseAmount)} USDC</strong></div><div class="order-row"><span>Network</span><strong>Solana</strong></div><div class="order-row"><span>Est. spread</span><strong>0.20%</strong></div><div class="order-row"><span>Settlement</span><strong>Atomic</strong></div></div>
          <button class="btn btn-accent" style="width:100%;margin-top:20px" data-action="review-order">${state.walletConnected ? "Review order" : "Connect to buy"}</button>
        </aside>
      </div>`,
  }));
}

function updatePurchaseDisplay() {
  const quantity = state.purchaseAmount / state.selectedAsset.price;
  document.querySelector("#order-total")?.replaceChildren(document.createTextNode(`${quantity.toFixed(4)} ${state.selectedAsset.symbol}`));
  document.querySelector("#order-pay")?.replaceChildren(document.createTextNode(`${money(state.purchaseAmount)} USDC`));
}

function activityModal() {
  openModal(modalShell({
    eyebrow: "Wallet ledger",
    title: "Recent activity",
    description: "Every lock, hand settlement, and release remains auditable.",
    body: `<div class="private-list">
      ${[
        ["Buy-in locked", "Market Mix I · 0.1762 AAPLx", "−$40.00"],
        ["Pot settled", "Hand #1837 · runner-runner flush", "+$12.40"],
        ["Seat released", "Opening Bell · 0.0931 NVDAx", "+$17.01"],
      ].map((row, i) => `<div class="private-room"><span class="private-icon" style="background:${["#ddd5ff", "#d7ff86", "#ccecff"][i]}">${["↘", "+", "↗"][i]}</span><span class="private-copy"><strong>${row[0]}</strong><span>${row[1]}</span></span><strong style="font-family:var(--mono);font-size:11px">${row[2]}</strong></div>`).join("")}
    </div>`,
  }));
}

function takeSeat() {
  if (!state.walletConnected) {
    closeModal();
    walletModal("buyin");
    return;
  }
  const required = state.buyInAmount / state.selectedAsset.price;
  if (required > state.selectedAsset.balance) {
    toast(`Not enough ${state.selectedAsset.symbol}. Buy more to take this seat.`);
    return;
  }
  closeModal();
  state.view = "table";
  render();
  toast(`${money(state.buyInAmount)} locked. You're seated.`);
}

function toast(message) {
  const root = document.querySelector("#toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function bindEvents(root = document) {
  root.querySelectorAll("[data-action]").forEach((el) => {
    if (el.dataset.bound) return;
    el.dataset.bound = "true";
    el.addEventListener("click", handleAction);
    if (el.classList.contains("room-card")) {
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          el.click();
        }
      });
    }
  });

  root.querySelector("#buyin-range")?.addEventListener("input", (event) => {
    state.buyInAmount = Number(event.target.value);
    updateBuyinDisplay();
  });

  root.querySelector("#purchase-input")?.addEventListener("input", (event) => {
    state.purchaseAmount = Math.max(5, Number(event.target.value) || 5);
    updatePurchaseDisplay();
  });

  root.querySelector("#bet-range")?.addEventListener("input", (event) => {
    document.querySelector("#raise-value").textContent = money(Number(event.target.value));
  });
}

function handleAction(event) {
  const target = event.currentTarget;
  const action = target.dataset.action;
  if (action === "close-modal") {
    if (target.classList.contains("modal-overlay") && event.target !== target) return;
    closeModal();
  }
  if (action === "go-lobby") { event.preventDefault(); closeModal(); state.view = "lobby"; render(); }
  if (action === "open-wallet") walletModal();
  if (action === "connect-provider") connectProvider(target);
  if (action === "open-host") hostModal();
  if (action === "show-activity") activityModal();
  if (action === "focus-bankroll") document.querySelector("#bankroll")?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (action === "open-buy") buyStocksModal();
  if (action === "asset-buy") { state.selectedAsset = ASSETS.find((a) => a.symbol === target.dataset.symbol); buyStocksModal(); }
  if (action === "open-buyin") buyinModal(PUBLIC_ROOMS.find((room) => room.id === target.dataset.room));
  if (action === "quick-seat") buyinModal(PUBLIC_ROOMS.find((room) => room.players < room.seats) || PUBLIC_ROOMS[0]);
  if (action === "join-private") {
    const room = state.privateRooms.find((item) => item.id === target.dataset.room);
    buyinModal({ ...room, accent: "#ddd5ff", rake: `${room.rake}% · host cap` });
  }
  if (action === "select-asset") {
    state.selectedAsset = ASSETS.find((asset) => asset.symbol === target.dataset.symbol);
    buyinModal(state.selectedRoom);
  }
  if (action === "set-buyin") { state.buyInAmount = Number(target.dataset.value); updateBuyinDisplay(); }
  if (action === "take-seat") takeSeat();
  if (action === "host-game") {
    state.hostGame = target.dataset.value;
    target.parentElement.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === target));
  }
  if (action === "toggle") {
    target.classList.toggle("on");
    target.setAttribute("aria-pressed", String(target.classList.contains("on")));
  }
  if (action === "create-room") createRoom();
  if (action === "select-buy-asset") { state.selectedAsset = ASSETS.find((asset) => asset.symbol === target.dataset.symbol); buyStocksModal(); }
  if (action === "set-purchase") {
    state.purchaseAmount = Number(target.dataset.value);
    const input = document.querySelector("#purchase-input");
    if (input) input.value = state.purchaseAmount;
    updatePurchaseDisplay();
  }
  if (action === "review-order") {
    if (!state.walletConnected) { closeModal(); walletModal("buy"); return; }
    const bought = state.purchaseAmount / state.selectedAsset.price;
    state.selectedAsset.balance += bought;
    closeModal(); render(); toast(`Demo order filled: ${bought.toFixed(4)} ${state.selectedAsset.symbol}.`);
  }
  if (action === "poker-action") toast(`${target.dataset.name}. Waiting for the next player…`);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector(".modal-overlay")) closeModal();
});

render();
