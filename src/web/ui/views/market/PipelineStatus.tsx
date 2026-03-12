import { useState } from "react";
import type { PipelineStatus as PipelineStatusType } from "./types";

interface Props {
  readonly status: PipelineStatusType;
}

export default function PipelineStatus({ status }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-bg-1 border border-border rounded-lg p-5">
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={() => setOpen((prev) => !prev)}
      >
        <h3 className="m-0">Pipeline Status</h3>
        <span
          className="text-sm text-muted transition-transform duration-200 ease-in-out"
          style={{
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          &#x25BC;
        </span>
      </div>

      {!open && (
        <div className="flex gap-6 mt-2.5 text-sm text-muted">
          <span>
            <span
              className="inline-block w-2 h-2 rounded-full mr-1.5"
              style={{
                background: status.running
                  ? "var(--color-success)"
                  : "var(--color-danger)",
                boxShadow: status.running
                  ? "0 0 8px rgba(45,212,191,0.5)"
                  : "0 0 8px rgba(248,113,113,0.4)",
              }}
            />
            {status.running ? "Running" : "Stopped"}
          </span>
          <span>
            QDB:{" "}
            {status.questdbConnected ? (
              <span className="text-success">Connected</span>
            ) : (
              <span className="text-danger">Disconnected</span>
            )}
          </span>
          <span>Symbols: {status.symbols.join(", ")}</span>
        </div>
      )}

      {open && (
        <div className="mt-5">
          <div className="flex gap-8 flex-wrap mb-5">
            <div>
              <strong>Running:</strong>{" "}
              <span className={status.running ? "text-success" : "text-danger"}>
                {status.running ? "Yes" : "No"}
              </span>
            </div>
            <div>
              <strong>QuestDB:</strong>{" "}
              <span
                className={
                  status.questdbConnected ? "text-success" : "text-danger"
                }
              >
                {status.questdbConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div>
              <strong>Markets:</strong> {status.marketTypes.join(", ")}
            </div>
            <div>
              <strong>Symbols:</strong> {status.symbols.join(", ")}
            </div>
          </div>

          {status.backfill.length > 0 && (
            <div className="mb-5">
              <h4 className="mb-2.5 text-base">Backfill</h4>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Market</th>
                    <th className="text-left">Symbol</th>
                    <th className="text-left">TF</th>
                    <th className="text-left">Status</th>
                    <th className="text-right">Candles</th>
                  </tr>
                </thead>
                <tbody>
                  {status.backfill.map((b, i) => (
                    <tr key={i}>
                      <td>{b.marketType}</td>
                      <td>{b.symbol}</td>
                      <td>{b.timeframe}</td>
                      <td>
                        <span
                          className="inline-block px-2.5 py-1 rounded-full text-black text-xs font-medium"
                          style={{
                            background:
                              b.status === "completed"
                                ? "var(--color-success)"
                                : b.status === "error"
                                  ? "var(--color-danger)"
                                  : "var(--color-warning)",
                          }}
                        >
                          {b.status}
                        </span>
                      </td>
                      <td className="text-right">
                        {b.fetchedCandles.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {status.streams.length > 0 && (
            <div>
              <h4 className="mb-2.5 text-base">Streams</h4>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Market</th>
                    <th className="text-left">Symbol</th>
                    <th className="text-left">TF</th>
                    <th className="text-left">Status</th>
                    <th className="text-right">Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {status.streams.map((s, i) => (
                    <tr key={i}>
                      <td>{s.marketType}</td>
                      <td>{s.symbol}</td>
                      <td>{s.timeframe}</td>
                      <td>
                        <span
                          className={
                            s.connected ? "text-success" : "text-danger"
                          }
                        >
                          {s.connected ? "Connected" : "Disconnected"}
                        </span>
                      </td>
                      <td className="text-right">
                        {s.messagesReceived.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
