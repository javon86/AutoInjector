# Stable Diffusion with AutoInjector — Windows setup guide

AutoInjector makes pictures with **Stable Diffusion (SD)** running on your own PC
and your own graphics card. It does not contain SD itself; it connects to an SD
app — and it can **start that app for you**, or **install one** if you have none.

Everything lives in the **🎨 Images** tab (top of the window, next to 🤖 AutoInjector
and 📖 Akọwe):

| View | What it does |
|---|---|
| 🖌 **Generate** | prompt, negative prompt, character lock, LoRAs (with weights), checkpoint, VAE, sampler, size, steps, CFG, seed, batch → **Generate**, progress + **Stop**, result + gallery, **♻ Remake** / **🎲 Variation** |
| 📚 **Library** | all your checkpoints, LoRAs, embeddings and VAEs with preview pictures, base model (SD1.5 / SDXL / Pony / Flux…), trigger words; your own tags, collections, ★, default weight, notes |
| 🔒 **Character locks** | a LoRA + trigger words + fixed looks for one book character, so the face stays the same |
| 🧩 **Add-ons** | what is installed in your SD app, a short list of useful add-ons (extensions) with **⬇ Install**, **↻ Update** and **🗑 Remove**, install from a GitHub link, **🔁 Restart Forge now**, and **Open Forge's own Extensions page** |
| ⚙ **Start & install** | start a Stability Matrix package (or the ComfyUI AutoInjector installed) hidden, with the API on; or **⬇ Install Stable Diffusion**; **Advanced: another server** — a list of common addresses, 🔍 Auto-detect, ✓ Check it answers, and the on/off switch (for an SD app on another computer or an odd port) |

The **🎨 Images** button in the AutoInjector tab's action bar opens this tab (the old Image Generation panel is gone — this is the one place).

Pictures are saved in AutoInjector's **`stuff and thing/images/`** folder. Every
picture carries its settings (inside the PNG, and in a `.json` file next to it), so
**♻ Remake** makes the same picture again.

There are three ways to get going. Pick one.

---

## Route 1 — Stability Matrix (recommended)

[Stability Matrix](https://github.com/LykosAI/StabilityMatrix) is a free program that
installs and updates the SD apps for you and keeps **one shared models folder**
for all of them.

### 1. Install Stability Matrix

1. Download it from <https://github.com/LykosAI/StabilityMatrix/releases> (the
   Windows `.zip`), unzip it somewhere with plenty of space (e.g. `D:\StabilityMatrix`),
   and run `StabilityMatrix.exe`.
2. On first start choose **Portable mode** (keeps everything in a `Data` folder next to
   the program) or a library folder — AutoInjector finds both.

### 2. Add a package

Click **Add Package** and pick one:

- **SD WebUI Forge** (or **reForge**) — easiest, fast, good on 6–8 GB cards. *Recommended.*
- **ComfyUI** — very flexible; AutoInjector builds its workflow for you.
- Automatic1111 and SD.Next also work. Fooocus and InvokeAI don't (they have no API
  AutoInjector can drive).

Let it finish installing (the first time takes a while).

### 3. Get models

Use Stability Matrix's **Model Browser** (Civitai / Hugging Face) or copy files into:

| What | Folder (portable mode) |
|---|---|
| Checkpoints (the main model, 2–7 GB) | `StabilityMatrix\Data\Models\StableDiffusion` |
| LoRAs ("lores") | `StabilityMatrix\Data\Models\Lora` (and `LyCORIS`) |
| VAEs | `StabilityMatrix\Data\Models\VAE` |
| Embeddings | `StabilityMatrix\Data\Models\Embeddings` |

Sub-folders are fine (e.g. `Lora\Characters\odile_face.safetensors`). When the Model
Browser downloads a model it also saves its Civitai info and a preview picture —
AutoInjector reads those (trigger words, base model, preview).

A good first checkpoint: an **SD 1.5** model such as DreamShaper 8 (2 GB, works on 4 GB+
cards) or an **SDXL** model (6–7 GB, needs 8 GB+).

### 4. Turn the API on (Forge / reForge / A1111 / SD.Next)

AutoInjector talks to the WebUI through its **API**, which is **off by default**.

- **If AutoInjector starts the package for you** (step 5, "▶ Start"), it adds `--api`
  itself — nothing to do.
- **If you start it from Stability Matrix yourself:** click the **⚙ (gear) next to the
  package's Launch button → Launch Options → tick "API"** (or type `--api` in *Extra
  launch arguments*) → **Save**, then **Launch**.

ComfyUI doesn't need this.

### 5. Start it and connect

Open **🎨 Images**. Either:

- press **▶ Start SD WebUI Forge with API** on the bar (or **⚙ Start & install → ▶ Start**).
  AutoInjector starts the package hidden, waits until it is ready (the first start can take
  several minutes), and connects. The status shows **"✔ SD WebUI Forge running on :7860
  (managed)"**. It restarts the package if it crashes and stops it when you quit
  AutoInjector. Tick **"Start Stable Diffusion with AutoInjector"** to have it start every
  time (off by default). **📄 Open log** shows its output (no passwords or tokens in it).
- **or** start the package in Stability Matrix yourself, then press **🔍 Find my SD app**.

You should see **"✔ Connected to Forge on :7860 — model …"**. Press
**🧪 Test: make a 512px image** — a small picture of an apple means it works.

> **"API is switched off"?** AutoInjector found the WebUI but its API is off. Do step 4
> and start it again.

---

## Route 2 — "⬇ Install Stable Diffusion" (nothing installed yet)

In **🎨 Images → ⚙ Start & install**, press **⬇ Install Stable Diffusion**. AutoInjector:

1. **Checks your graphics card** (NVIDIA via `nvidia-smi`, otherwise Windows' own list):
   - NVIDIA RTX 20xx or newer → the official ComfyUI **NVIDIA** build;
   - NVIDIA GTX 10xx or older → the **NVIDIA cu126** build;
   - AMD Radeon → the **AMD** build (works on recent cards, slower);
   - Intel Arc → the **Intel** build;
   - no suitable card → it still runs on the processor, but one picture takes minutes.
2. **Checks free disk space** — about 4 GB for ComfyUI plus 2–7 GB per model.
3. **Downloads the official ComfyUI portable for Windows** (from ComfyUI's GitHub
   releases, about 2 GB) into `%LOCALAPPDATA%\AutoInjector\comfyui`, with a progress bar.
   **⏸ Pause** stops it; pressing Install again **continues where it stopped**. The file's
   size and SHA-256 are checked against what GitHub publishes.
4. **Unpacks it** with 7-Zip if you have it, otherwise with Windows' own `tar`. If neither
   can unpack it, install [7-Zip](https://7-zip.org) and press Install again (the download
   is kept).
5. Offers **one starter model** (you choose, size shown first): *DreamShaper 8 (SD 1.5,
   2.1 GB)* or *SDXL base 1.0 (6.9 GB, needs 8 GB+)*. It goes into
   `…\comfyui\ComfyUI_windows_portable\ComfyUI\models\checkpoints`.

Then press **▶ Start** — status **"✔ ComfyUI running on :8188 (managed)"** — and
**Generate**. The 📚 Library includes ComfyUI's `models` folder automatically; put more
checkpoints in `models\checkpoints` and LoRAs in `models\loras`.

AutoInjector never overwrites or deletes your files: an existing install is reused, and a
file already in the way is left alone (you get a message instead).

---

## Route 3 — a standalone install you already have

### Forge / reForge / Automatic1111

1. Edit **`webui-user.bat`** in Notepad and make the arguments line read
   `set COMMANDLINE_ARGS=--api` (keep anything already there, e.g. `--api --xformers`).
2. Start `webui-user.bat` (or `run.bat` for the Forge one-click package) and wait for
   `Running on local URL: http://127.0.0.1:7860`.
3. In **🎨 Images** press **🔍 Find my SD app** (or type `http://127.0.0.1:7860` and **Connect**).
4. In **📚 Library → ＋ Add folder** pick the WebUI folder — AutoInjector finds
   `models\Stable-diffusion`, `models\Lora`, `models\VAE` and `embeddings` inside.

### ComfyUI (portable or desktop app)

Start it (`run_nvidia_gpu.bat`; the desktop app uses port **8000**), then **🔍 Find my
SD app** — AutoInjector checks ports 7860–7865, 8188, 8000 and 8888. Add its folder in
📚 Library → ＋ Add folder (it finds `models\checkpoints`, `models\loras`, …).

---

## Using it

### Good pictures by default (PR #128)

The 🖌 Generate form is one short block for the narrow panel: **Engine · Checkpoint** (with a
badge for the model family), **Style**, **Size**, **Prompt**, **Negative** (one line until you
open it), **🧩 LoRAs**, **🔒 Character**, then **⚙ More settings** and the folded extra steps.
The 🎨 Generate / ⏹ Stop bar stays at the bottom. Open sections, the style and the size are
remembered.

| Model family (from the checkpoint) | Sizes (Portrait / Square / Landscape) | Sampler + scheduler | Steps | CFG |
|---|---|---|---|---|
| SDXL (also Pony, Illustrious, NoobAI) | 832×1216 / 1024×1024 / 1216×832 | DPM++ 2M + Karras | 28 | 5.5 (Pony 6) |
| SD 1.5 | 512×768 / 512×512 / 768×512 (+ ✨ Hires ×1.5) | DPM++ 2M + Karras | 28 | 7 |
| Flux | 896×1152 / 1024×1024 / 1152×896 | Euler + Simple | 20 | 1 (Forge's distilled CFG 3.5) |

- **Which family?** The library's read of the file's header, else its name (`sd_xl_base_1.0` → SDXL),
  else its size (about 7 GB → SDXL, 2–4 GB → SD 1.5, 11 GB+ → Flux).
- **SDXL at 512 px makes poor, cartoonish pictures** — it is made for about one megapixel. The size
  buttons always use the family's own sizes; **Custom** shows the exact Width / Height sliders and
  warns when SDXL is used below 768×768 worth of pixels. A request from Alfred or Akọwe at such a
  size is made at SDXL's own size (with a ⚠ line saying so).
- **"(default)" sampler** = the family's best one, but only a name your SD app lists (the list
  says "(default → DPM++ 2M)"). Steps and CFG follow the family until you move them yourself.
- **Negative prompt:** empty = a sensible default ("lowres, blurry, deformed, bad anatomy, extra
  fingers, watermark, text …"); Flux has none (it ignores it). Your own words replace it.
- **Style chips:** 📷 Photo-real (RAW photo, natural skin texture, sharp focus — and "cartoon, 3d
  render" to avoid), 🎬 Cinematic, 🖊 Illustration, ✨ Anime, 🖌 Painting. Click again to turn off.
- **Long prompts:** CLIP reads 75 tokens at a time and the first words count most. Above about 150
  tokens the tab shows **📝 Shortened for the model** (show what is sent / shorten off): who, the
  looks (age, build, skin, hair, eyes, scars), clothing, place, light, style — the story is left out.
  Akọwe's and Alfred's long prompts are shortened the same way. The full text is kept in the
  picture's `.json` (`fullPrompt`).
- **📖 Book pictures use** (⚙ More settings): the checkpoint Akọwe's book pictures are made with.
  It starts as "whatever is loaded" — nothing is switched unless you choose one; a character lock's
  own checkpoint still wins. Every picture shows which checkpoint (and family) made it.
- Callers that need exact settings send `quality: false` (`images.generate`).

### LoRAs

- **🧩 LoRAs** opens a small LoRA browser under the LoRA row (like the SD app's Lora tab, sized for
  the panel): search (name, trigger words, tags), **All / Fits SDXL / Recent / ★**, and cards with
  the preview picture next to the file (`.preview.png`, `.png`, Civitai Helper) or its initials,
  the base model (from `ss_base_model_version` / `modelspec.architecture` / `.civitai.info`), its
  trigger words (or the most used tags of its training set) and ☆/★. Click a card to add it; ⛔
  marks one made for another model family. **↻** asks the SD app to look for new LoRAs
  (`/sdapi/v1/refresh-loras`) and rescans the folders ("stuff and thing"/models/lora, Stability
  Matrix's Data\Models\Lora, the SD app's own folder).
- Each chosen LoRA is a row: name, a **weight slider** (−1 … 2, step 0.05, default 0.8 or its own
  default), **🔑** (put its trigger words in the prompt) and **✕**.
- **Type to find a LoRA…** next to the button still works: type and pick one. It becomes a row with a weight (its
  default weight, usually 0.8) and its **trigger words are added to the prompt**. Forge /
  A1111 get `<lora:name:0.8>` in the prompt; ComfyUI gets LoRA loader nodes. You can also
  type `<lora:name:0.8>` yourself — both backends understand it.
- **Wrong base model warning:** a LoRA made for SD 1.5 does nothing (or garbage) on an SDXL
  checkpoint. AutoInjector reads each file's base model and warns in red ("won't work") or
  yellow (Pony/Illustrious on plain SDXL: "may look off").
- **Library:** AutoInjector reads only the small header at the start of each
  `.safetensors` file (never the whole model) plus the info files next to it
  (`.cm-info.json` from Stability Matrix, `.civitai.info` from Civitai Helper, A1111's
  `.json`, `.txt`, preview pictures). Your tags, collections, favourites, weights, notes and
  character locks are stored in AutoInjector's own `sd-library.json` (in its settings
  folder). **Your model files are never changed.**
- **Character locks** (🔒): name the character, add their LoRA(s) and trigger words, the
  looks that never change ("short silver hair, green eyes, navy wool coat"), optionally a
  checkpoint and seed. Pick the lock in 🖌 Generate, or press **🎨 Try a portrait**. Akọwe will
  use these for character portraits and covers (see `docs/SD_IMAGE_API.md`).

## 🧩 Add-ons (extensions)

Add-ons give Forge (or A1111 / SD.Next) new tools. In ComfyUI they are called
*custom nodes*. Open **🎨 Images → 🧩 Add-ons**.

**What you see**

- **Where they go:** Forge's add-ons folder, for example
  `…\StabilityMatrix\Data\Packages\stable-diffusion-webui-forge\extensions`. AutoInjector
  finds it the same way it finds Forge to start it (Stability Matrix's packages).
- **Useful add-ons**, each with one line saying what it does:
  - **ADetailer**: fixes faces and hands by itself after each picture.
  - **ControlNet**: copies a pose, an outline or the depth from a picture. *Forge already has it
    built in*, so it says "✔ built in" there. On Automatic1111 you can install it.
  - **Regional Prompter**: different words for different parts of the picture.
  - **Dynamic Prompts**: random choices in a prompt, like `{red|blue|green} dress`.
  - **Tiled Diffusion (MultiDiffusion)**: very large pictures in tiles. Forge has its own built in.
  - **Ultimate SD Upscale**: makes a picture 2× or 4× bigger and adds detail.
  - **ReActor (face swap)**: only with faces of people who said yes. It asks you first.
  - For ComfyUI the list is ComfyUI-Manager, Impact Pack (Face Detailer), ControlNet
    preprocessors, Ultimate SD Upscale, Dynamic Prompts and ReActor.
- **Installed:** everything in the add-ons folder, and what Forge itself says it has loaded.
  Each one has **↻ Update** and **🗑 Remove**.

**Installing**

1. Press **⬇ Install** next to the add-on. A bar shows the download.
2. AutoInjector copies the add-on's files into the folder. It uses `git` (Stability Matrix's
   own copy, or Git for Windows). With no git on the PC it downloads the add-on as a zip
   from GitHub instead. It never runs the add-on itself.
3. The add-on shows **⏳ restart Forge to turn it on**. Then:
   - If AutoInjector started Forge (▶ Start), press **🔁 Restart Forge now**.
   - If you started Forge in Stability Matrix, press **Stop** and then **Launch** there.
   The first start after an install can take a few minutes while Forge sets the add-on up.
4. Press **↻ Check again**. The add-on now shows **✔ installed**.

**Install from a link:** paste the add-on's GitHub (or GitLab) page, such as
`https://github.com/Bing-su/adetailer`, and press **⬇ Install from this link**. Only links
from github.com and gitlab.com are accepted, and it asks you first: **only install add-ons
you trust**, because an add-on runs inside Forge with full access to your PC.

**Remove** moves the add-on into a `_removed` folder next to the add-ons folder
(for example `…\stable-diffusion-webui-forge\_removed\adetailer-20261105-093000`).
Nothing is deleted; move it back to undo. If Windows says its files are in use, stop Forge
first.

**If AutoInjector can't find Forge's folder** it says so. Press **📂 Choose the folder…**
and pick the folder that has `launch.py` and `extensions` in it. With Stability Matrix
that is `Data\Packages\stable-diffusion-webui-forge` (the ⋮ menu on Forge's card in
Stability Matrix can open it). Picking the whole `Data` folder works too.
AutoInjector remembers the folder.

**Prefer Forge's own screen?** **Open Forge's own Extensions page ↗** opens Forge in a
window inside AutoInjector and switches to its **Extensions** tab (Available → Load from →
Install). Stability Matrix also has its own add-on manager: on the Packages page, the ⋮ menu
on Forge's card → Extensions.

**From a picture:** when 🖌 Generate leaves ADetailer or ControlNet out because Forge doesn't
have it, the ⚠ line has a **🧩 Install it** button that opens this page on that add-on.

## Troubleshooting

| You see | Do this |
|---|---|
| "Nothing is answering at http://127.0.0.1:7860" | The SD app isn't running — press ▶ Start, or start it yourself and wait for "Running on local URL". |
| "…its API is switched off" | Route 1 step 4 / Route 3 step 1 (`--api`). |
| "Your graphics card ran out of memory" | Smaller size (512×512 for SD 1.5, 1024×1024 for SDXL), batch 1, fewer LoRAs; A1111: add `--medvram`. |
| "ComfyUI doesn't have “x”" | That model/LoRA isn't in ComfyUI's folders — press 🔍 Find / Connect again to refresh the lists and pick one. |
| "…Python was not found" when starting a Stability Matrix package | Start it once from Stability Matrix so it finishes installing, then ▶ Start again. |
| The first picture takes minutes | Normal after a start — the model is loading. The next ones are much faster. |
| "⏳ restart Forge to turn it on" stays after a restart | Open Forge's log (⚙ Start & install → 📄 Open log, or Stability Matrix's console). Forge prints why an add-on did not load (often a missing download on the first start; restart once more). |
| "GitHub says that add-on doesn't exist" | Open the link in your browser. The add-on may have moved or been taken down. |
| Fooocus found | Fooocus has no API AutoInjector can use; add Forge or ComfyUI in Stability Matrix (same models). |

Model licences (SD 1.5, SDXL, Flux, Pony, …) differ — using them is your responsibility.
