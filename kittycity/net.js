// Kitty City — P2P networking via PeerJS (WebRTC + free public broker).
// Host-authoritative: host owns the sim; guests send ops, receive diffs.
//
// Messages:
//  guest->host: {t:"hello", name, color}  {t:"op", tool, tiles}  {t:"cursor", x,y}
//  host->guest: {t:"state", json}  {t:"tiles", changed, fish}
//               {t:"econ", fish, pop, level, happiness, income, cats}
//               {t:"levelup", ...}  {t:"cursor", ...(relayed, with name/color)}
//               {t:"peers", names:[...]}

const ROOM_PREFIX = "kittycity-mrow-";

function makePeer() {
  // default free PeerJS cloud broker
  return new Peer(undefined, { debug: 1 });
}

class HostNet {
  constructor(onOp, onCursor, onPeers) {
    this.conns = new Map(); // peerId -> {conn, name, color}
    this.onOp = onOp;
    this.onCursor = onCursor;
    this.onPeers = onPeers;
    this.roomId = null;
    this.getStateJson = null; // set by main
    this.ready = new Promise((resolve, reject) => {
      const suffix = Math.random().toString(36).slice(2, 8);
      this.peer = new Peer(ROOM_PREFIX + suffix, { debug: 1 });
      this.peer.on("open", id => { this.roomId = id.slice(ROOM_PREFIX.length); resolve(this.roomId); });
      this.peer.on("error", e => {
        if (String(e.type) === "unavailable-id") {
          // rare collision: retry once with a new suffix
          const s2 = Math.random().toString(36).slice(2, 8);
          this.peer = new Peer(ROOM_PREFIX + s2, { debug: 1 });
          this.peer.on("open", id => { this.roomId = id.slice(ROOM_PREFIX.length); this._listen(); resolve(this.roomId); });
          this.peer.on("error", reject);
        } else if (!this.roomId) reject(e);
      });
    });
    this.ready.then(() => this._listen());
  }

  _listen() {
    this.peer.on("connection", conn => {
      conn.on("open", () => {
        this.conns.set(conn.peer, { conn, name: "?", color: "#b9bdc4" });
        // send full state immediately
        if (this.getStateJson) conn.send({ t: "state", json: this.getStateJson() });
      });
      conn.on("data", d => {
        const rec = this.conns.get(conn.peer);
        if (!rec) return;
        if (d.t === "hello") {
          rec.name = String(d.name || "cat").slice(0, 14);
          rec.color = d.color;
          this._broadcastPeers();
        } else if (d.t === "op") {
          this.onOp(d, conn.peer);
        } else if (d.t === "cursor") {
          // relay to everyone else with identity attached
          const msg = { t: "cursor", id: conn.peer, x: d.x, y: d.y, name: rec.name, color: rec.color };
          this.onCursor(msg);
          for (const [pid, r] of this.conns) if (pid !== conn.peer) r.conn.send(msg);
        }
      });
      const drop = () => {
        this.conns.delete(conn.peer);
        this._broadcastPeers();
      };
      conn.on("close", drop);
      conn.on("error", drop);
    });
  }

  _broadcastPeers() {
    const names = [...this.conns.values()].map(r => r.name);
    this.onPeers(names);
    this.broadcast({ t: "peers", names });
  }

  broadcast(msg) {
    for (const { conn } of this.conns.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  sendCursor(x, y, name, color) {
    this.broadcast({ t: "cursor", id: "host", x, y, name, color });
  }
}

class GuestNet {
  constructor(roomId, hello, handlers) {
    this.handlers = handlers;
    this.peer = makePeer();
    this.open = false;
    this.peer.on("open", () => {
      this.conn = this.peer.connect(ROOM_PREFIX + roomId, { reliable: true });
      this.conn.on("open", () => {
        this.open = true;
        this.conn.send({ t: "hello", ...hello });
        handlers.onOpen?.();
      });
      this.conn.on("data", d => {
        const h = this.handlers["on" + d.t[0].toUpperCase() + d.t.slice(1)];
        h?.(d);
      });
      this.conn.on("close", () => { this.open = false; handlers.onClosed?.(); });
      this.conn.on("error", () => { this.open = false; handlers.onClosed?.(); });
    });
    this.peer.on("error", e => {
      if (String(e.type) === "peer-unavailable") handlers.onNoRoom?.();
    });
  }

  send(msg) { if (this.open) this.conn.send(msg); }
}

export { HostNet, GuestNet };
