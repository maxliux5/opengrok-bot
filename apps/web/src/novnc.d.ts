declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string } });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    resizeSession: boolean;
    sendKey(keysym: number, code: string): void;
    addEventListener(type: "connect" | "disconnect" | "credentialsrequired", listener: () => void): void;
    disconnect(): void;
  }
}
