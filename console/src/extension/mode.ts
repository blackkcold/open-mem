export type ExtensionSurface = "panel" | "page" | "status";

type ExtensionWindow = Window & {
  __OPENMEM_EXTENSION__?: boolean;
  __OPENMEM_SURFACE__?: string;
};

export function isExtension(): boolean {
  return (window as ExtensionWindow).__OPENMEM_EXTENSION__ === true;
}

export function extensionSurface(): ExtensionSurface {
  const value = (window as ExtensionWindow).__OPENMEM_SURFACE__;
  return value === "panel" || value === "status" ? value : "page";
}
