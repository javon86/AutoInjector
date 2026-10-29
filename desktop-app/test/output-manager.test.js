// test/output-manager.test.js — the output folder layout + safe file handling.
// Uses a throwaway temp dir as "Documents". Run: node test/output-manager.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const om = require("../output-manager");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function main() {
  const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  const root = om.init(appFolder);

  console.log("\n== init lays out the one 'stuff and thing' folder inside the app folder ==");
  assert(root === path.join(appFolder, "stuff and thing"), "root is <app folder>/stuff and thing");
  assert(fs.existsSync(root), "the folder is created");
  assert(fs.existsSync(path.join(root, "README.txt")) && /stuff and thing/.test(fs.readFileSync(path.join(root, "README.txt"), "utf8")), "a top-level README explains the whole folder");

  console.log("\n== category folders ==");
  assert(path.basename(om.imagesDir()) === "images" && fs.existsSync(om.imagesDir()), "images/ exists");
  assert(path.basename(om.videosDir()) === "videos", "videos/");
  assert(path.basename(om.uploadsDir()) === "uploads", "uploads/");
  assert(om.bookDir("My Great Book").endsWith(path.join("books", "My Great Book")), "books/<title>/");
  assert(om.aiWorkDir("claude").endsWith(path.join("ai-work", "claude")), "ai-work/<site>/");

  console.log("\n== models & assets downloads folder (inside stuff and thing) ==");
  assert(om.modelsRoot() === path.join(root, "models"), "modelsRoot is <stuff and thing>/models");
  assert(fs.existsSync(om.modelsRoot()), "the models folder is created on init");
  for (const k of ["llm", "image", "loras", "video", "voice", "assets"]) {
    assert(fs.existsSync(om.modelsDir(k)) && path.basename(om.modelsDir(k)) === k, `models/${k}/ exists`);
  }
  assert(fs.existsSync(path.join(om.modelsRoot(), "README.txt")), "a top-level README explains what goes where");
  assert(fs.existsSync(path.join(om.modelsDir("llm"), "README.txt")) && /OLLAMA_MODELS/.test(fs.readFileSync(path.join(om.modelsDir("llm"), "README.txt"), "utf8")), "the llm/ README tells you to set OLLAMA_MODELS");
  // A file dropped into a category is counted by the inventory.
  fs.writeFileSync(path.join(om.modelsDir("image"), "model.safetensors"), "x");
  const inv = om.modelsInventory();
  assert(inv.root === om.modelsRoot() && inv.categories.image === 1 && inv.categories.llm === 0, "modelsInventory counts files per category (ignoring READMEs)");

  console.log("\n== the Stability Matrix folder set (fixed names the transfer and the programs use) ==");
  const want = ["image", "loras", "loras/lycoris", "vae", "vae/approx", "embeddings", "controlnet", "upscale", "text_encoders", "diffusion_models", "clip_vision", "ipadapter", "detectors/ultralytics/bbox", "detectors/ultralytics/segm", "detectors/sams", "faces", "video/framepack/hf", "llm", "voice", "assets"];
  for (const rel of want) {
    const d = path.join(om.modelsRoot(), ...rel.split("/"));
    const readme = path.join(d, "README.txt");
    assert(fs.existsSync(d) && fs.existsSync(readme) && fs.readFileSync(readme, "utf8").length > 40, `models/${rel}/ exists with a plain README`);
  }
  const smNames = { image: "StableDiffusion", loras: "Lora", "loras/lycoris": "LyCORIS", vae: "VAE", "vae/approx": "ApproxVAE", embeddings: "Embeddings", controlnet: "ControlNet", upscale: "ESRGAN", text_encoders: "TextEncoders", diffusion_models: "DiffusionModels", clip_vision: "ClipVision", ipadapter: "IpAdapter", "detectors/ultralytics/bbox": "Ultralytics", "detectors/sams": "Sams", faces: "insightface", "video/framepack/hf": "FramePack" };
  for (const [rel, sm] of Object.entries(smNames)) assert(fs.readFileSync(path.join(om.modelsRoot(), ...rel.split("/"), "README.txt"), "utf8").includes(sm), `models/${rel}/README.txt names the Stability Matrix folder (${sm})`);
  assert(/RealESRGAN, SwinIR, ScuNET, BSRGAN, LDSR, upscale_models/.test(fs.readFileSync(path.join(om.modelsDir("upscale"), "README.txt"), "utf8")), "upscale/ README lists every Stability Matrix upscaler folder");
  assert(om.modelsDir("lycoris") === path.join(om.modelsRoot(), "loras", "lycoris") && om.modelsDir("ultralytics_bbox") === path.join(om.modelsRoot(), "detectors", "ultralytics", "bbox") && om.modelsDir("framepack") === path.join(om.modelsRoot(), "video", "framepack", "hf"), "modelsDir knows the nested folders");
  assert(om.workflowsDir() === path.join(root, "workflows") && fs.existsSync(path.join(root, "workflows", "README.txt")), "workflows/ (ComfyUI workflow .json files) exists with a README");
  assert(/models\/detectors\/ultralytics\/bbox\//.test(fs.readFileSync(path.join(root, "README.txt"), "utf8")) && /workflows\//.test(fs.readFileSync(path.join(root, "README.txt"), "utf8")), "the top README shows the whole folder set");
  const mr = fs.readFileSync(path.join(om.modelsRoot(), "README.txt"), "utf8");
  assert(/autoinjector_stuff/.test(mr) && /--lora-dir/.test(mr) && /video\/framepack\/hf\//.test(mr), "models/README explains Forge args + the ComfyUI section + every folder");

  console.log("\n== what is in each folder (📦 Your models) and which folders the programs get ==");
  fs.writeFileSync(path.join(om.modelsDir("loras"), "a.safetensors"), "x");
  fs.writeFileSync(path.join(om.modelsDir("lycoris"), "b.safetensors"), "x");
  fs.writeFileSync(path.join(om.modelsDir("lycoris"), "c.safetensors"), "x");
  fs.writeFileSync(path.join(om.modelsDir("ultralytics_bbox"), "face_yolov8m.pt"), "x");
  fs.mkdirSync(path.join(om.modelsDir("framepack"), "hub", "models--lllyasviel--FramePackI2V_HY", "snapshots", "86c"), { recursive: true });
  fs.writeFileSync(path.join(om.modelsDir("framepack"), "hub", "models--lllyasviel--FramePackI2V_HY", "snapshots", "86c", "diffusion_pytorch_model-00001-of-00003.safetensors"), "x");
  fs.writeFileSync(path.join(root, "workflows", "flow.json"), "{}");
  const inv2 = om.modelsInventory();
  const F = (k) => inv2.folders.find((f) => f.key === k);
  assert(F("loras").files === 1 && F("lycoris").files === 2, "loras/ counts its own files, loras/lycoris/ its own (not double)");
  assert(F("ultralytics_bbox").files === 1 && F("framepack").files === 1 && F("image").files === 1 && F("vae").files === 0, "nested folders are counted (YOLO bbox, FramePack's HF cache)");
  assert(inv2.workflows === 1 && F("image").label && F("image").sm === "StableDiffusion", "workflows counted; each folder has a label + its Stability Matrix name");
  const md = om.modelDirsWithFiles();
  assert(md.image === om.modelsDir("image") && md.loras === om.modelsDir("loras") && md.lycoris === om.modelsDir("lycoris") && md.ultralytics_bbox && !md.vae && !md.embeddings && !md.llm, `only folders with model files are handed to the programs (${Object.keys(md).join(", ")})`);
  const lf = om.libraryFolders();
  assert(["checkpoint", "lora", "vae", "embedding"].every((k) => lf.some((f) => f.kind === k)) && lf.find((f) => f.kind === "vae").path === om.modelsDir("vae") && lf.every((f) => /stuff and thing/.test(f.source)), "the Model & LoRA library scans image/, loras/, vae/, embeddings/ of \"stuff and thing\"");

  console.log("\n== name sanitization blocks path traversal and illegal chars ==");
  assert(om.safeName("../../etc/passwd") === "etc passwd", "strips ../ and separators");
  assert(om.safeName("..") === "untitled", "a pure-traversal name falls back");
  assert(!/[\\/]/.test(om.safeName("a/b\\c")), "no separators survive");
  assert(om.safeName("") === "untitled", "empty -> fallback");
  // A malicious book title cannot escape the books folder.
  const evil = om.bookDir("../../secret");
  assert(evil.startsWith(path.join(root, "books")) && evil.includes("secret"), "a traversal title stays inside books/");

  console.log("\n== saveBuffer writes and never clobbers ==");
  const a = om.saveBuffer(om.imagesDir(), "pic.png", Buffer.from([1, 2, 3]));
  const b = om.saveBuffer(om.imagesDir(), "pic.png", Buffer.from([4, 5, 6]));
  assert(fs.existsSync(a) && fs.existsSync(b), "both writes land");
  assert(a !== b && /pic-1\.png$/.test(b), "the second write becomes pic-1.png (no overwrite)");
  assert(fs.readFileSync(a).length === 3 && fs.readFileSync(b).length === 3, "contents are independent");

  console.log("\n== copyInto copies an existing file in ==");
  const src = path.join(appFolder, "some upload.txt");
  fs.writeFileSync(src, "hello");
  const dest = om.copyInto(om.uploadsDir(), src);
  assert(fs.existsSync(dest) && dest.endsWith(path.join("uploads", "some upload.txt")), "copied into uploads/ under its name");
  assert(fs.readFileSync(dest, "utf8") === "hello", "content copied intact");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
