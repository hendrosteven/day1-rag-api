import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { pool } from "./db.js";
import { extractPdfText } from "./cvParser.js";
import { storeChunksForExistingDocument, searchRelevantChunks, storeCandidateMetadata, hybridCandidateSearch } from "./ragService.js";
import { openai } from "./openai.js";

dotenv.config();

const app = express();
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.post("/api/cv/upload", upload.single("cv"), async (req, res) => {
    try {
        const rawText = await extractPdfText(req.file.path);

        const result = await pool.query(
            `INSERT INTO cv_documents (file_name, raw_text, processing_status)
       VALUES ($1, $2, 'UPLOADED')
       RETURNING id, file_name, processing_status`,
            [req.file.originalname, rawText]
        );

        res.json({
            success: true,
            document: result.rows[0],
        });
    } catch (error) {
        console.error("Error processing CV:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/cv/search", async (req, res) => {
    try {
        const { query, threshold = 1.0 } = req.body;
        const results = await searchRelevantChunks(query, 5, threshold);

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

app.post("/api/cv/:documentId/process", async (req, res) => {
    const { documentId } = req.params;

    try {
        const docResult = await pool.query(
            `SELECT * FROM cv_documents WHERE id = $1`,
            [documentId]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: "Document not found" });
        }

        const document = docResult.rows[0];

        await pool.query(
            `UPDATE cv_documents
       SET processing_status = 'PROCESSING', processing_error = NULL
       WHERE id = $1`,
            [documentId]
        );

        try {
            const chunkInfo = await storeChunksForExistingDocument(
                documentId,
                document.raw_text
            );

            const metadata = await storeCandidateMetadata(
                documentId,
                document.raw_text
            );

            await pool.query(
                `UPDATE cv_documents
         SET processing_status = 'COMPLETED'
         WHERE id = $1`,
                [documentId]
            );

            res.json({
                success: true,
                message: "Document processed successfully",
                chunkInfo,
                metadata,
            });
        } catch (processingError) {
            await pool.query(
                `UPDATE cv_documents
         SET processing_status = 'FAILED', processing_error = $2
         WHERE id = $1`,
                [documentId, processingError.message]
            );

            throw processingError;
        }
    } catch (error) {
        console.error("Error processing document:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/cv/:documentId/status", async (req, res) => {
    try {
        const { documentId } = req.params;

        const result = await pool.query(
            `SELECT id, file_name, processing_status, processing_error, created_at
       FROM cv_documents
       WHERE id = $1`,
            [documentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Document not found" });
        }

        res.json({ document: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/candidates/hybrid-search", async (req, res) => {
    try {
        const results = await hybridCandidateSearch(req.body);
        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});

