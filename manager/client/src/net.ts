export type MapSizeId = "89x59" | "119x79";

export type ClientMsg =
  | { type: "hello"; playerId?: string; name?: string }
  | { type: "ping"; t: number }
  | {
      type: "create_room";
      mapSize: MapSizeId;
      seed?: number | string;
      allowRespawn: boolean;
      maxPlayers: number;
      /** Base64 encrypted `.wopsave` for restore-only create. */
      saveBlob?: string;
    }
  | { type: "join_room"; roomId: string }
  | {
      type: "queue_match";
      playerCount?: number;
      teamFormat?:
        | "2v2"
        | "3v3"
        | "4v4"
        | "2v2v2"
        | "3v3v3"
        | "2v2v2v2";
    }
  | { type: "cancel_queue" }
  | { type: "leave_room" };

export type ServerMsg = {
  type: string;
  [key: string]: unknown;
};

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export type LobbySocketHandlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (msg: ServerMsg) => void;
};

export class LobbySocket {
  private ws: WebSocket | null = null;
  private handlers: LobbySocketHandlers;
  private intentionallyClosed = false;

  constructor(handlers: LobbySocketHandlers = {}) {
    this.handlers = handlers;
  }

  setHandlers(handlers: LobbySocketHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.intentionallyClosed = false;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onclose = () => {
      this.handlers.onClose?.();
      if (!this.intentionallyClosed) {
        window.setTimeout(() => this.connect(), 1200);
      }
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        this.handlers.onMessage?.(msg);
      } catch {
        /* ignore */
      }
    };
  }

  close(): void {
    this.intentionallyClosed = true;
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
