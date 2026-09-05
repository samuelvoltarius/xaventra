# Commercialization guide

This document is an engineering release checklist, not legal advice.

## Choose the license model before publication

The repository currently uses MIT. Publishing a version under MIT permanently
allows recipients to use, modify, redistribute, sublicense and sell that
version while retaining the required notices. Later proprietary releases do
not revoke rights already granted for earlier MIT releases.

Common product models are:

- MIT core plus paid hosting, support and managed mesh operations;
- open core with separately owned commercial enterprise modules;
- dual licensing where all necessary copyrights are controlled by one entity;
- a proprietary distribution with selected SDKs and protocols released openly.

## Required release gates

1. `npm ci` succeeds in a clean environment using only committed files.
2. Typecheck, build and the full test suite pass.
3. Secret, privacy and topology scans return no production values.
4. `npm run sbom:generate` is current and third-party notices are complete.
5. GPL/LGPL dependencies and vendored source are reviewed for the chosen
   distribution model.
6. Every logo, font, screenshot, model and dataset has documented provenance.
7. Contributors have granted rights compatible with the selected model.
8. Product telemetry, memory and account handling have privacy documentation.
9. Release signing, update rollback and vulnerability reporting are tested.
10. Brand and trademark clearance is performed in target markets.

## Private and public editions

Keep personal runtime configuration, memories, node identities, credentials and
private operational playbooks outside this repository. The public repository
contains examples only. A private deployment may layer those assets from a
separate encrypted configuration repository or secrets manager.

Never merge the private runtime history into the public Git repository.
