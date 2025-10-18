const express = require('express');
    const cors = require('cors');
    const { GoogleGenerativeAI } = require("@google/generative-ai");

    const app = express();
    app.use(cors());
    app.use(express.json());

    if (!process.env.GOOGLE_API_KEY) {
      throw new Error("API Key not found. Please add GOOGLE_API_KEY to environment variables.");
    }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    // We will keep gemini-pro here for now, but we might change it based on the list we get.
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    // --- NEW DIAGNOSTIC ENDPOINT ---
    // This endpoint will help us see exactly which models are available for your API key.
    app.get('/list-models', async (req, res) => {
      try {
        console.log("Listing available models...");
        const result = await genAI.listModels();
        const modelNames = [];
        for (const m of result) {
          modelNames.push(m.name);
        }
        console.log("Available models:", modelNames);
        res.json({ availableModels: modelNames });
      } catch (error) {
        console.error("Error listing models:", error);
        res.status(500).json({ error: 'Could not list models.' });
      }
    });

    // The chat endpoint that your app will call
    app.post('/chat', async (req, res) => {
      try {
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
        // Send a more specific error back to the app for debugging
        res.status(500).json({ error: error.message });
      }
    });

    // Start the server
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
