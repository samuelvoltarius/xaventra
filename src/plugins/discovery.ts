import type { novaPackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./types.js";

export type DiscoverednovaPlugin = {
  origin: PluginOrigin;
  packageName?: string;
  packageDir?: string;
  packagenova?: novaPackageManifest;
};

export function discovernovaPlugins(): { candidates: DiscoverednovaPlugin[] } {
  return {
    candidates: [
      {
        origin: "bundled",
        packageName: "@nova/msteams",
        packagenova: {
          install: { npmSpec: "@nova/msteams" },
          channel: {
            id: "msteams",
            label: "Microsoft Teams",
            selectionLabel: "Microsoft Teams (Bot Framework)",
            docsPath: "/channels/msteams",
            blurb: "Bot Framework; enterprise support.",
            aliases: ["teams"],
          },
        },
      },
    ],
  };
}
