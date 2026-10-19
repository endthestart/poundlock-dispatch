import type { Session } from "electron";

/**
 * Refuse every web permission the renderer could ask for: camera, microphone,
 * notifications, geolocation, clipboard, devices. Dispatch's renderer needs
 * none of them (desktop notifications come from the main process), and any
 * page that ever ran in it must not get one either (L26).
 */
export function denyPermissionRequests(
  target: Pick<
    Session,
    "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setDevicePermissionHandler"
  >,
): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
}
