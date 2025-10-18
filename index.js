 const express = require('express');
    const cors = require('cors');
    const { GoogleGenerativeAI } = require("@google/generative-ai");

    const app = express();
    app.use(cors());
    app.use(express.json());

    // --- A VISIBLE MARKER TO CONFIRM DEPLOYMENT ---
    // This will be our proof that the new code is live.
    app.get('/', (req, res) => {
      res.json({ 
        status: "EduApp AI Proxy is running!", 
        version: "2.0",
        message: "The new code has been deployed successfully." 
      });
    });

    if (!process.env.GOOGLE_API_KEY) {
      console.error("FATAL ERROR: GOOGLE_API_KEY is not defined in environment variables.");
    }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    app.get('/list-models', async (req, res) => {
      try {
        const result = await genAI.listModels();
        const modelInfo = [];
        for (const m of result) {
          modelInfo.push({ name: m.name, displayName: m.displayName });
        }
        res.json({ availableModels: modelInfo });
      } catch (error) {
        console.error("Error listing models:", error.message);
        res.status(500).json({ error: 'Could not list models.', details: error.message });
      }
    });

    app.post('/chat', async (req, res) => {
      try {
        // --- THE FINAL FIX ---
        // We will use the model name that we get from /list-models
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); // Using a very recent and likely available model
        
        const userMessage = req.body.message;
        if (!userMessage) {
          return res.status(400).json({ error: 'Message is required' });
        }

        const result = await model.generateContent(userMessage);
        const response = await result.response;
        const botReply = response.text();

        res.json({ reply: botReply });

      } catch (error) {
        console.error("Error processing chat:", error.message);
        res.status(500).json({ error: error.message });
      }
    });

    const port = process.env.PORT || 10000;
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
