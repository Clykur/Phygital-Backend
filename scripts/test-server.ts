import express from "express";
import { corsMiddleware } from "../src/middleware/cors";

const app = express();
app.use((req, res, next) => {
  console.log("Req origin:", req.headers.origin);
  next();
});
app.use(corsMiddleware);
app.get("/api/catalog/books", (req, res) => res.json({ books: [] }));

app.listen(8788, () => console.log("Test server running on 8788"));
