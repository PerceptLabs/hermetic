// @hermetic/net — Type definitions

import type { Disposable } from "@hermetic/core";

/** Handler function that processes requests from the preview iframe */
export type ServerHandler = (request: Request) => Response | Promise<Response>;

export interface PreviewOptions {
  /** Request handler — receives Request, returns Response */
  handler: ServerHandler;
  /** Container element to append iframe to (default: document.body) */
  container?: HTMLElement;
  /** Custom HTML to inject into the preview */
  html?: string;
  /** Base URL for the virtual location */
  baseUrl?: string;
}

export interface PreviewHandle extends Disposable {
  /** The sandbox iframe element */
  iframe: HTMLIFrameElement;
  /** Navigate to a virtual URL */
  navigate(url: string): void;
  /** Inject HTML content into the preview */
  setContent(html: string): void;
}

/** Internal message format for fetch requests sent from iframe shim to host */
export interface FetchRequestMessage {
  __hermetic: true;
  ns: "net";
  id: string;
  type: "fetch";
  url: string;
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

/** Internal message format for fetch responses sent from host to iframe shim */
export interface FetchResponseMessage {
  __hermetic: true;
  ns: "net";
  id: string;
  type: "fetch-response";
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
  streaming?: boolean;
}
