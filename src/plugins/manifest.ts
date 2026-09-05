export type novaPackageManifest = {
  install?: {
    npmSpec?: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
  channel?: {
    id?: string;
    label?: string;
    selectionLabel?: string;
    detailLabel?: string;
    docsPath?: string;
    docsLabel?: string;
    blurb?: string;
    aliases?: string[];
    preferOver?: string[];
    order?: number;
    selectionDocsPrefix?: string;
    selectionDocsOmitLabel?: boolean;
    selectionExtras?: string[];
    systemImage?: string;
    showConfigured?: boolean;
    quickstartAllowFrom?: string[];
    forceAccountBinding?: boolean;
    preferSessionLookupForAnnounceTarget?: boolean;
  };
};
