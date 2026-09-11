# Third-party notices

## PaddleOCR / RapidOCR model files

This project bundles the following OCR assets:

- `src-tauri/resources/models/ch_PP-OCRv4_det_infer.onnx`
- `src-tauri/resources/models/ch_PP-OCRv4_rec_infer.onnx`
- `src-tauri/resources/models/ch_ppocr_mobile_v2.0_cls_infer.onnx`

The three ONNX files are exact, unmodified copies of the matching artifacts
published in the SWHL/RapidOCR model repository. RapidOCR describes these as
ONNX conversions of PaddleOCR models. The application does not perform additional model format
conversion. Do not remove upstream attribution or license information when
repackaging these assets.

PaddleOCR and RapidOCR publish their respective projects under the Apache
License, Version 2.0:

- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- PaddleOCR license: https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE
- RapidOCR: https://github.com/RapidAI/RapidOCR
- RapidOCR license: https://github.com/RapidAI/RapidOCR/blob/main/LICENSE

Model artifact references:

- Detection: https://huggingface.co/SWHL/RapidOCR/blob/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx
- Recognition: https://huggingface.co/SWHL/RapidOCR/blob/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx
- Classification: https://huggingface.co/SWHL/RapidOCR/blob/main/PP-OCRv1/ch_ppocr_mobile_v2.0_cls_infer.onnx

The application source code in this repository is licensed separately under
the Apache License 2.0 in `LICENSE`. This file does not relicense third-party
assets; their original terms continue to apply.

Copies of upstream license texts are in `licenses/upstream/`.

## Project dictionary

According to the project maintainer, `src-tauri/resources/models/ppocr_keys_v1.txt`
was generated using AI for this project. It is distributed under the project's
Apache-2.0 license. This provenance statement is supplied by the maintainer;
it is not a claim that independent authorship was technically verified.

## Software dependencies

`licenses/dependencies.json` records package names, exact versions, declared
licenses, authors where available, source locations and paths to notice texts.
The corresponding full texts are in `licenses/texts/`. This inventory includes
Windows Rust dependencies and installed npm packages, including build and
development tools; inclusion does not mean every listed component is shipped.
Third-party components retain their own licenses.

Some crate packages omit a standalone license file. Where Apache-2.0 is an
available alternative, that alternative and its complete text are included.
Supplemental upstream texts and their provenance are documented in
`licenses/README.md`.

## MPL-2.0 source availability

The inventory includes MPL-2.0 components cssparser, cssparser-macros,
dtoa-short, option-ext and selectors, plus the npm build tools lightningcss
and lightningcss-win32-x64-msvc. Their original source code is available
from the exact-version package download URLs recorded in `dependencies.json`.
Lightning CSS source repository: https://github.com/parcel-bundler/lightningcss
These dependency sources have not been modified by this project. They remain
under MPL-2.0; the application's Apache-2.0 declaration does not replace it.
If redistributing modified versions of these components, provide their
corresponding modified source under MPL-2.0 and update this notice.

## ONNX Runtime

The locked ort-sys 2.0.0-rc.13 distribution table selects ONNX Runtime 1.28.0
prebuilt packages from https://cdn.pyke.io/ for the default build.
ONNX Runtime is copyright Microsoft Corporation and licensed under MIT.
Its license and third-party notices from the upstream v1.28.0 tag are included
in `licenses/upstream/onnxruntime-LICENSE.txt` and
`licenses/upstream/onnxruntime-ThirdPartyNotices.txt`.
Source: https://github.com/microsoft/onnxruntime/tree/v1.28.0
If substituting a runtime binary or enabling different execution providers,
check that binary's accompanying notices and update the bundled documents.

## Asset fingerprints

SHA-256 fingerprints of the bundled files:

```text
D2A7720D45A54257208B1E13E36A8479894CB74155A5EFE29462512D42F49DA9  ch_PP-OCRv4_det_infer.onnx
48FC40F24F6D2A207A2B1091D3437EB3CC3EB6B676DC3EF9C37384005483683B  ch_PP-OCRv4_rec_infer.onnx
E47ACEDF663230F8863FF1AB0E64DD2D82B838FCEB5957146DAB185A89D6215C  ch_ppocr_mobile_v2.0_cls_infer.onnx
8F8806654E29EAF88144A5B50643D1FB4F0D3EC9B60F6FEE2B924EEAA921556A  ppocr_keys_v1.txt
```
