import multer from "multer";
import path from "path";
import fs from "fs";

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname) || "";
    const rnd = Math.random().toString(36).slice(2, 8);
    cb(null, `${ts}-${rnd}${ext}`);
  },
});

const upload = multer({ storage });

export default upload;
