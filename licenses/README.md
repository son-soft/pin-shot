# Bundled licenses

Keep this directory, the root LICENSE and THIRD_PARTY_NOTICES.md with installers
and portable distributions. Tauri's resource configuration includes them.

`dependencies.json` is an intentionally conservative inventory of Windows Cargo
packages and installed npm packages, including build and development dependencies.
Each entry links exact package versions to retained license/notice texts.
MPL-2.0 source download locations are provided in each affected entry.

Run `pnpm install --frozen-lockfile`, ensure Windows Cargo dependencies are cached,
then run `pnpm licenses:generate` after dependency changes. Review new license
expressions and upstream notices before committing the generated files.
`pnpm licenses:check` checks input hashes and notice files; it does not replace
review of new licenses. The normal frontend build runs this check automatically.

Supplemental upstream texts:

- alloc-stdlib: https://github.com/dropbox/rust-alloc-no-stdlib/blob/master/LICENSE
- webview2-com family: https://github.com/wravery/webview2-rs/blob/main/LICENSE
- saxes 6.0.0: https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE
- ONNX Runtime 1.28.0: https://github.com/microsoft/onnxruntime/tree/v1.28.0
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE
- RapidOCR: https://github.com/RapidAI/RapidOCR/blob/main/LICENSE

For packages offering Apache-2.0 but missing a license file, the standard
Apache-2.0 text is included. The selectors MPL-2.0 text is the same standard
text shipped by cssparser. The platform-specific rolldown binding uses the
parent package's notices. stackback's MIT declaration and author are taken
from its package metadata; its V8-derived source header is also preserved.

The default runtime notices correspond to the version in the locked ort-sys
download table. Custom runtime binaries/providers require their own review.
Before publishing an installer, inspect the actual installed resources to
confirm these documents accompany the binary. Merely copying the executable
does not create a complete portable distribution.
