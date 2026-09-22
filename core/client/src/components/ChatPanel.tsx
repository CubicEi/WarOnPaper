import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export interface ChatMessage {
  id: number;
  playerId: string;
  name: string;
  text: string;
  t: number;
  mine?: boolean;
}

interface Props {
  messages: readonly ChatMessage[];
  width: number;
  onSend: (text: string) => void;
}

/** Compact chat stacked above the minimap: collapsed = last line; expand for history. */
export function ChatPanel({ messages, width, onSend }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const last = messages.length > 0 ? messages[messages.length - 1] : null;

  useEffect(() => {
    if (!expanded || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [expanded, messages]);

  const submit = (ev?: FormEvent) => {
    ev?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-panel" style={{ width }} aria-label="对局聊天">
      {expanded && (
        <div className="chat-history" ref={listRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">暂无消息</div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`chat-line${m.mine ? " is-mine" : ""}`}>
                <span className="chat-name">{m.name}</span>
                <span className="chat-text">{m.text}</span>
              </div>
            ))
          )}
        </div>
      )}
      {!expanded && (
        <div className="chat-last" title={last ? `${last.name}: ${last.text}` : undefined}>
          {last ? (
            <>
              <span className="chat-name">{last.name}</span>
              <span className="chat-text">{last.text}</span>
            </>
          ) : (
            <span className="chat-empty">暂无消息</span>
          )}
        </div>
      )}
      <form className="chat-compose" onSubmit={submit}>
        <input
          className="chat-input"
          type="text"
          value={draft}
          maxLength={200}
          placeholder="输入消息…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="聊天输入"
        />
        <button type="submit" className="chat-send" disabled={!draft.trim()}>
          发送
        </button>
        <button
          type="button"
          className={`chat-expand${expanded ? " is-open" : ""}`}
          title={expanded ? "收起聊天" : "展开聊天历史"}
          aria-label={expanded ? "收起聊天" : "展开聊天历史"}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="chat-chevron" aria-hidden />
        </button>
      </form>
    </div>
  );
}
