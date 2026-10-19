import type { DispatchApi } from "./index";

declare global {
  interface Window {
    poundlockDispatch: DispatchApi;
  }
}

export {};
