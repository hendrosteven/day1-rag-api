import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import { extractPdfText } from "./cvParser.js";
import { storeDocumentWithChunks, searchRelevantChunks } from "./ragService.js";
import { openai } from "./openai.js";

dotenv.config();

const app = express();
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.post("/api/cv/upload", upload.single("cv"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded. Send a PDF using the 'cv' field as multipart/form-data." });
        }
        const text = await extractPdfText(req.file.path);
        const result = await storeDocumentWithChunks(req.file.originalname, text);

        res.json({
            success: true,
            fileName: req.file.originalname,
            ...result,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (req.file?.path) {
            fs.unlink(req.file.path, () => { });
        }
    }
});

app.post("/api/cv/search", async (req, res) => {
    try {
        const { query } = req.body;
        const results = await searchRelevantChunks(query, 5, 0.8);

        res.json({ results, count: results.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/cv/ask", async (req, res) => {
    try {
        const { question } = req.body;
        const chunks = await searchRelevantChunks(question, 10);

        const context = chunks.map((c, i) => {
            return `[Chunk ${i + 1}] File: ${c.file_name}\n${c.content}`;
        }).join("\n\n");

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Answer only based on the provided CV context. If there is not enough information, say there is not enough information.",
                },
                {
                    role: "user",
                    content: `Context:\n${context}\n\nQuestion: ${question}`,
                },
            ],
        });

        res.json({
            answer: response.choices[0].message.content,
            retrievedChunks: chunks,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});