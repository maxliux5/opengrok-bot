import { useEffect, useRef, useState } from "react";
import { AlertCircle, Monitor, RefreshCw, RotateCcw, Lock, Unlock, Power, Maximize2, Minimize2, Scan, ZoomIn, CornerDownLeft } from "lucide-react";
import RFB from "@novnc/novnc";
import { api, json } from "./client";

type Computer = {
  status: "ready" | "starting" | "stopped" | "unavailable";
  controlMode: "agent" | "human" | "handing_off" | "restarting";
  controlId: string | null;
  detail?: string;
};

function setViewportMode(connection: RFB, nativeSize: boolean) {
  connection.dragViewport = nativeSize;
  if (nativeSize) {
    connection.clipViewport = true;
    connection.scaleViewport = false;
  } else {
    connection.scaleViewport = true;
    connection.clipViewport = false;
  }
}

export default function Desktop() {
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [nativeSize, setNativeSize] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const result = await api<{ computer: Computer }>("/computer");
        if (live) setComputer(result.computer);
      } catch (cause) {
        if (live) setError((cause as Error).message);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [reload]);

  useEffect(() => {
    if (computer?.status !== "ready" || !target.current) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = new RFB(target.current, `${protocol}//${location.host}/desktop`);
    rfb.current = connection;
    setViewportMode(connection, nativeSize);
    connection.resizeSession = false;
    connection.viewOnly = computer.controlMode !== "human";
    connection.addEventListener("connect", () => setConnected(true));
    connection.addEventListener("disconnect", () => setConnected(false));
    return () => {
      if (rfb.current === connection) rfb.current = null;
      connection.disconnect(); setConnected(false);
    };
  }, [computer?.status, computer?.controlMode, connectionRevision, expanded]);

  useEffect(() => {
    if (rfb.current) setViewportMode(rfb.current, nativeSize);
  }, [nativeSize]);

  async function toggleControl() {
    try {
      setError("");
      if (computer?.controlMode === "human" && computer.controlId) {
        await api(`/computer/control/${computer.controlId}`, { method: "DELETE" });
      } else {
        await api("/computer/control", json("POST", {}));
      }
      setReload(value => value + 1);
    } catch (cause) { setError((cause as Error).message); }
  }

  async function startComputer() {
    try {
      setError("");
      await api("/computer/ensure", { method: "POST" });
      setReload(value => value + 1);
    } catch (cause) { setError((cause as Error).message); }
  }

  async function restartComputer() {
    if (!window.confirm("重启会终止电脑中正在运行的程序；未确认的操作会保留待核对。继续？")) return;
    try {
      setError("");
      await api("/computer/restart", json("POST", {}));
      setReload(value => value + 1);
    } catch (cause) { setError((cause as Error).message); }
  }

  const ready = computer?.status === "ready";
  const human = computer?.controlMode === "human";
  const pending = computer?.controlMode === "handing_off";
  const restarting = computer?.controlMode === "restarting";
  const statusText = pending ? "控制权交接中" : restarting ? "电脑重启中" :
    ready ? connected ? "电脑已连接" : "连接中" :
    computer?.status === "starting" ? "电脑启动中" :
    computer?.status === "stopped" ? "电脑未启动" : "电脑暂不可用";
  return <div className={`desktop-pane${expanded ? " expanded" : ""}`}>
    <div className="desktop-toolbar">
      <div className="desktop-status"><span className={`status-dot ${ready && connected ? "online" : ""}`} />
        {statusText}
      </div>
      <div className="toolbar-actions">
        {computer?.status === "stopped" && <button className="icon-button" title="启动电脑" onClick={() => void startComputer()}><Power size={16} /></button>}
        {(computer?.status === "unavailable" || computer?.controlMode === "handing_off" ||
          computer?.controlMode === "restarting") &&
          <button className="icon-button" title="重启电脑" disabled={computer?.status === "starting"}
            onClick={() => void restartComputer()}><RotateCcw size={16} /></button>}
        <button className="icon-button" title="重新连接桌面" onClick={() => {
          setReload(value => value + 1);
          setConnectionRevision(value => value + 1);
        }}><RefreshCw size={16} /></button>
        <button className="icon-button" title={nativeSize ? "适应窗口" : "原尺寸查看，可拖动画面"}
          aria-pressed={nativeSize} onClick={() => setNativeSize(value => !value)}>
          {nativeSize ? <Scan size={16} /> : <ZoomIn size={16} />}
        </button>
        <button className="icon-button desktop-enter-button" title="发送回车"
          disabled={!ready || !connected || !human} onClick={() => rfb.current?.sendKey(0xff0d, "Enter")}>
          <CornerDownLeft size={16} />
        </button>
        <button className="icon-button" title={expanded ? "收起电脑" : "展开电脑"} onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button className="control-button" disabled={!ready || computer?.controlMode === "handing_off" ||
          computer?.controlMode === "restarting"} onClick={toggleControl}>
          {human ? <Lock size={16} /> : <Unlock size={16} />}{human ? "归还控制" : "接管电脑"}
        </button>
      </div>
    </div>
    {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
    <div className="desktop-stage">
      {!ready && <div className="desktop-empty"><Monitor size={34} strokeWidth={1.5} />
        <strong>{pending ? "等待交接" : restarting ? "正在重启" : "电脑未就绪"}</strong>
        <span>{computer?.detail || "等待 Docker 桌面服务连接"}</span></div>}
      <div ref={target} className="novnc-target" style={{ display: ready ? "block" : "none" }} />
    </div>
    <div className="desktop-footer"><span>{computer?.controlMode === "restarting" ? "正在重启" :
      computer?.controlMode === "handing_off" ? "控制权交接中" : human ? "你正在操作电脑" : "观察模式"}</span><span>Linux 桌面</span></div>
  </div>;
}
