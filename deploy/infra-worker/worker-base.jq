{
  version,
  models,
  resilience,
  codex: { fallbackModel: .codex.fallbackModel },
  mesh: {
    direct: {
      peers: (
        (.mesh.direct.peers // []) + [
          {
            nodeId: "nova-spark",
            url: "ws://100.64.0.10:9091",
            publicKey: ([.mesh.update.trustedReleaseKeys[] | select(.nodeId == "nova-spark") | .publicKey][0]),
            roles: ["system", "owner", "admin", "worker"],
            allowedTools: .mesh.security.allowedTools
          }
        ]
      )
    },
    security: .mesh.security,
    supabase: .mesh.supabase,
    relay: .mesh.relay,
    coordination: .mesh.coordination,
    update: { trustedReleaseKeys: .mesh.update.trustedReleaseKeys }
  }
}
