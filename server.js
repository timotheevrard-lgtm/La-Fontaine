import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;
const MONGODB_URI = process.env.MONGODB_URI;

// ── MongoDB Session Store ─────────────────────────────────────────

let db;
let sessionsCollection;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("story-agent");
  sessionsCollection = db.collection("sessions");
  console.log("✅ MongoDB connecté !");
}

async function loadSession(sessionId) {
  return await sessionsCollection.findOne({ sessionId });
}

async function saveSession(sessionId, data) {
  await sessionsCollection.updateOne(
    { sessionId },
    { $set: { sessionId, ...data } },
    { upsert: true }
  );
}

async function listSessions() {
  return await sessionsCollection
    .find({}, { projection: { sessionId: 1, title: 1, chapterCount: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
}

// ── Notion API helpers ────────────────────────────────────────────

async function notionRequest(endpoint, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (data.object === "error") console.error("NOTION ERREUR:", JSON.stringify(data));
  return data;
}

// ── Notion Tool Implementations ──────────────────────────────────

async function setupStoryStructure({ storyTitle, storyDescription, genre }) {
  const mainPage = await notionRequest("/pages", "POST", {
    parent: { page_id: NOTION_PARENT_PAGE_ID },
    properties: {
      title: { title: [{ text: { content: `📖 ${storyTitle}` } }] },
    },
    children: [
      {
        object: "block",
        type: "callout",
        callout: {
          rich_text: [{ text: { content: storyDescription } }],
          icon: { emoji: "✨" },
          color: "purple_background",
        },
      },
      { object: "block", type: "divider", divider: {} },
    ],
  });

  const mainPageId = mainPage.id;

  const chaptersDb = await notionRequest("/databases", "POST", {
    parent: { page_id: mainPageId },
    title: [{ text: { content: "📚 Chapitres" } }],
    properties: {
      Titre: { title: {} },
      Numéro: { number: { format: "number" } },
      Statut: {
        select: {
          options: [
            { name: "Brouillon", color: "gray" },
            { name: "Rédigé", color: "green" },
            { name: "Révisé", color: "blue" },
          ],
        },
      },
      Résumé: { rich_text: {} },
    },
  });

  const charactersDb = await notionRequest("/databases", "POST", {
    parent: { page_id: mainPageId },
    title: [{ text: { content: "👥 Personnages" } }],
    properties: {
      Nom: { title: {} },
      Rôle: {
        select: {
          options: [
            { name: "Protagoniste", color: "green" },
            { name: "Antagoniste", color: "red" },
            { name: "Secondaire", color: "yellow" },
          ],
        },
      },
      Description: { rich_text: {} },
      Traits: { rich_text: {} },
    },
  });

  const universePage = await notionRequest("/pages", "POST", {
    parent: { page_id: mainPageId },
    properties: {
      title: { title: [{ text: { content: "🌍 Univers & Lore" } }] },
    },
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Genre : " + genre } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: "Complète cette page avec les règles, lieux et contexte de ton univers." } }],
        },
      },
    ],
  });

  return {
    success: true,
    mainPageId,
    chaptersDbId: chaptersDb.id,
    charactersDbId: charactersDb.id,
    universePageId: universePage.id,
    message: `Structure créée ! Page principale : ${mainPage.url}`,
  };
}

async function createChapterPage({ chaptersDbId, chapterNumber, chapterTitle, summary, content }) {
  const allBlocks = [
    {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [{ text: { content: summary } }],
        icon: { emoji: "📝" },
        color: "gray_background",
      },
    },
    { object: "block", type: "divider", divider: {} },
    ...content
      .split("\n\n")
      .filter((p) => p.trim())
      .flatMap((paragraph) => {
        const chunks = [];
        for (let i = 0; i < paragraph.length; i += 1900) {
          chunks.push(paragraph.slice(i, i + 1900));
        }
        return chunks.map((chunk) => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: chunk } }] },
        }));
      }),
  ];

  const chapterEntry = await notionRequest("/pages", "POST", {
    parent: { database_id: chaptersDbId },
    properties: {
      Titre: { title: [{ text: { content: chapterTitle } }] },
      Numéro: { number: chapterNumber },
      Statut: { select: { name: "Rédigé" } },
      Résumé: { rich_text: [{ text: { content: summary } }] },
    },
    children: allBlocks.slice(0, 100),
  });

  for (let i = 100; i < allBlocks.length; i += 100) {
    await notionRequest(`/blocks/${chapterEntry.id}/children`, "PATCH", {
      children: allBlocks.slice(i, i + 100),
    });
  }

  return {
    success: true,
    chapterUrl: chapterEntry.url,
    message: `Chapitre ${chapterNumber} "${chapterTitle}" créé dans Notion !`,
  };
}

async function addCharacter({ charactersDbId, name, role, description, traits }) {
  const character = await notionRequest("/pages", "POST", {
    parent: { database_id: charactersDbId },
    properties: {
      Nom: { title: [{ text: { content: name } }] },
      Rôle: { select: { name: role } },
      Description: { rich_text: [{ text: { content: description } }] },
      Traits: { rich_text: [{ text: { content: traits } }] },
    },
  });

  return {
    success: true,
    message: `Personnage "${name}" ajouté !`,
    url: character.url,
  };
}

async function readNotionPageContent(pageId) {
  // Get page properties
  const page = await notionRequest(`/pages/${pageId}`);
  console.log('PAGE LUE:', JSON.stringify(page).slice(0, 200));
  const title = page.properties?.title?.title?.[0]?.text?.content || 
                page.properties?.Name?.title?.[0]?.text?.content || "Page sans titre";

  // Get page blocks (content)
  const blocks = await notionRequest(`/blocks/${pageId}/children`);
  
  let content = `# ${title}\n\n`;
  
  for (const block of blocks.results || []) {
    if (block.type === "paragraph") {
      const text = block.paragraph?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += text + "\n\n";
    } else if (block.type === "heading_1") {
      const text = block.heading_1?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `# ${text}\n\n`;
    } else if (block.type === "heading_2") {
      const text = block.heading_2?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `## ${text}\n\n`;
    } else if (block.type === "heading_3") {
      const text = block.heading_3?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `### ${text}\n\n`;
    } else if (block.type === "bulleted_list_item") {
      const text = block.bulleted_list_item?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `- ${text}\n`;
    } else if (block.type === "callout") {
      const text = block.callout?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `> ${text}\n\n`;
    } else if (block.type === "child_database") {
      // Read child databases (like character databases)
      const dbTitle = block.child_database?.title || "Base de données";
      content += `## ${dbTitle}\n\n`;
      const dbContent = await notionRequest(`/databases/${block.id}/query`, "POST", {});
      for (const item of dbContent.results || []) {
        const name = Object.values(item.properties).find(p => p.type === "title")?.title?.[0]?.text?.content || "";
        if (name) {
          content += `### ${name}\n`;
          for (const [key, prop] of Object.entries(item.properties)) {
            if (prop.type === "rich_text" && prop.rich_text?.length > 0) {
              const val = prop.rich_text.map(r => r.text?.content).join("");
              if (val) content += `**${key}** : ${val}\n`;
            } else if (prop.type === "select" && prop.select) {
              content += `**${key}** : ${prop.select.name}\n`;
            }
          }
          content += "\n";
        }
      }
    }
  }

  return content.slice(0, 8000); // Limit to avoid token overflow
}

async function readChaptersFromNotion(chaptersDbId) {
  const db = await notionRequest(`/databases/${chaptersDbId}/query`, "POST", {
    sorts: [{ property: "Numéro", direction: "ascending" }],
  });

  const chapters = [];
  for (const page of db.results || []) {
    const num = page.properties?.Numéro?.number;
    const title = page.properties?.Titre?.title?.[0]?.text?.content || "";
    const summary = page.properties?.Résumé?.rich_text?.[0]?.text?.content || "";
    const blocks = await notionRequest(`/blocks/${page.id}/children`);
    const content = (blocks.results || [])
      .filter((b) => b.type === "paragraph")
      .map((b) => b.paragraph?.rich_text?.map((r) => r.text?.content).join("") || "")
      .filter(Boolean)
      .join("\n\n");

    chapters.push({ num, title, summary, content: content.slice(0, 3000) });
  }
  return chapters;
}

// ── Tool Definitions for Claude ──────────────────────────────────

const tools = [
  {
    name: "setup_story_structure",
    description: "Crée la structure complète dans Notion : page principale, base chapitres, base personnages, page univers. À appeler EN PREMIER avant tout.",
    input_schema: {
      type: "object",
      properties: {
        storyTitle: { type: "string", description: "Titre de l'histoire" },
        storyDescription: { type: "string", description: "Description courte de l'histoire" },
        genre: { type: "string", description: "Genre (Science-Fiction, Fantasy, Thriller...)" },
      },
      required: ["storyTitle", "storyDescription", "genre"],
    },
  },
  {
    name: "create_chapter_page",
    description: "Rédige un chapitre complet et le crée dans Notion.",
    input_schema: {
      type: "object",
      properties: {
        chaptersDbId: { type: "string", description: "ID de la base de données des chapitres" },
        chapterNumber: { type: "number", description: "Numéro du chapitre" },
        chapterTitle: { type: "string", description: "Titre du chapitre" },
        summary: { type: "string", description: "Résumé en 2-3 phrases du chapitre" },
        content: { type: "string", description: "Texte complet et détaillé du chapitre, bien développé, avec dialogues et descriptions" },
      },
      required: ["chaptersDbId", "chapterNumber", "chapterTitle", "summary", "content"],
    },
  },
  {
    name: "add_character",
    description: "Ajoute un personnage dans la base de données Notion.",
    input_schema: {
      type: "object",
      properties: {
        charactersDbId: { type: "string", description: "ID de la base de données des personnages" },
        name: { type: "string", description: "Nom du personnage" },
        role: { type: "string", enum: ["Protagoniste", "Antagoniste", "Secondaire"] },
        description: { type: "string", description: "Description physique et background" },
        traits: { type: "string", description: "Traits de personnalité principaux" },
      },
      required: ["charactersDbId", "name", "role", "description", "traits"],
    },
  },
];

// ── Agent Loop ───────────────────────────────────────────────────

async function runAgent(messages, onEvent) {
  const systemPrompt = `Tu es un agent créatif spécialisé dans l'écriture de romans détaillés. 
Tu génères des histoires riches, immersives et bien développées, puis tu les structures automatiquement dans Notion.

RÈGLES IMPORTANTES :
- Chaque chapitre doit être LONG et DÉTAILLÉ (minimum 1200-1500 mots), avec des dialogues, descriptions d'ambiance, pensées des personnages
- Pour les personnages PRINCIPAUX et SECONDAIRES : décris leur physique (visage, corpulence, façon de se mouvoir, vêtements, cicatrices), leur psychologie et leurs contradictions internes
- Pour les figurants : une touche descriptive suffit, pas besoin d'aller dans le détail
- Plante le contexte de l'époque naturellement, à travers des détails du quotidien et des dialogues, sans faire de longues digressions historiques
- Décris les lieux avec précision : architecture, odeurs, sons, lumières, températures
- Utilise des dialogues riches et révélateurs de caractère
- Chaque chapitre doit faire avancer l'intrigue ET approfondir l'univers
- Utilise setup_story_structure EN PREMIER si c'est une nouvelle histoire
- Ajoute les personnages principaux avec add_character avant ou après le premier chapitre
- Pour chaque chapitre, utilise create_chapter_page avec un contenu très développé
- Garde la cohérence narrative entre les chapitres
- Si l'utilisateur donne un brief, respecte-le mais enrichis-le
- Si l'utilisateur dit "chapitre suivant" sans brief, continue logiquement l'histoire

RÈGLES DE NUANCE ET DE STYLE :
- Ne JAMAIS répéter la même formulation pour exprimer une idée — trouve toujours un angle différent
- Les thèmes récurrents doivent être exprimés de façon INDIRECTE : à travers une action, un regard, un détail du décor, un souvenir, une ironie — jamais énoncés directement deux fois de suite
- Montre plutôt que tu ne dis : au lieu d'énoncer un trait de caractère, montre-le à travers le comportement
- Varie les points de vue narratifs : alterne entre pensées intérieures, dialogue, description externe

Tu dois TOUJOURS appeler les outils Notion, ne jamais juste afficher le texte sans le sauvegarder.`;

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8000,
      system: systemPrompt,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        onEvent({ type: "text", text: block.text });
      }
    }

    if (response.stop_reason === "end_turn") {
      onEvent({ type: "done" });
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        onEvent({ type: "tool", name: toolUse.name, input: toolUse.input });

        let result;
        try {
          if (toolUse.name === "setup_story_structure") {
            result = await setupStoryStructure(toolUse.input);
          } else if (toolUse.name === "create_chapter_page") {
            result = await createChapterPage(toolUse.input);
          } else if (toolUse.name === "add_character") {
            result = await addCharacter(toolUse.input);
          }
          onEvent({ type: "tool_result", name: toolUse.name, result });
        } catch (err) {
          result = { success: false, error: err.message };
          onEvent({ type: "tool_error", name: toolUse.name, error: err.message });
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }
  }
}

// ── API Routes ───────────────────────────────────────────────────

app.get("/api/sessions", async (req, res) => {
  const list = await listSessions();
  res.json(list);
});

app.post("/api/resume", async (req, res) => {
  const { sessionId } = req.body;
  const session = await loadSession(sessionId);
  if (!session) return res.status(404).json({ error: "Session introuvable" });
  res.json({
    sessionId,
    title: session.title,
    chapterCount: session.chapterCount,
    createdAt: session.createdAt,
  });
});

app.post("/api/start", async (req, res) => {
  const { storyBrief, notionPageUrl } = req.body;
  const sessionId = Date.now().toString();

  // Extract Notion page ID from URL if provided
  let notionContext = "";
  if (notionPageUrl) {
    try {
const urlParts = notionPageUrl.split("-");
const pageId = urlParts[urlParts.length - 1].split("?")[0].replace(/\//g, "");
console.log('URL reçue:', notionPageUrl);
console.log('ID extrait:', pageId);      const pageContent = await readNotionPageContent(pageId);
      notionContext = `\n\nL'utilisateur a préparé une page Notion avec son univers et ses personnages. UTILISE CES ÉLÉMENTS comme base pour l'histoire :\n\n${pageContent}`;
    } catch (e) {
      console.log("Impossible de lire la page Notion:", e.message);
    }
  }

  const messages = [
    {
      role: "user",
      content: `Nouvelle histoire : ${storyBrief}.${notionContext}
Commence par créer la structure Notion, ajoute les personnages principaux, puis écris le Chapitre 1 complet et détaillé.`,
    },
  ];

  const sessionData = {
    messages,
    chapterCount: 1,
    title: storyBrief.slice(0, 60),
    createdAt: new Date().toISOString(),
  };

  await saveSession(sessionId, sessionData);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await runAgent(messages, async (event) => {
      send(event);
      if (event.type === "tool_result" && event.name === "setup_story_structure") {
        sessionData.chaptersDbId = event.result?.chaptersDbId;
        await saveSession(sessionId, sessionData);
      }
      if (event.type === "tool_result" && event.name === "create_chapter_page") {
        sessionData.chapterCount++;
        await saveSession(sessionId, sessionData);
      }
    });
    sessionData.messages = messages;
    await saveSession(sessionId, sessionData);
    send({ type: "session", sessionId });
  } catch (err) {
    send({ type: "error", message: err.message });
  }

  res.end();
});

app.post("/api/chapter", async (req, res) => {
  const { sessionId, brief, corrections } = req.body;
  const session = await loadSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  let notionContext = "";
  if (session.chaptersDbId) {
    try {
      const chapters = await readChaptersFromNotion(session.chaptersDbId);
      if (chapters.length > 0) {
        notionContext = `\n\nVoici la version ACTUELLE des chapitres dans Notion (potentiellement modifiée par l'utilisateur) :\n` +
          chapters.map(c => `--- Chapitre ${c.num} : "${c.title}" ---\nRésumé : ${c.summary}\nExtrait : ${c.content.slice(0, 1500)}`).join("\n\n");
      }
    } catch (e) {
      console.log("Impossible de lire Notion:", e.message);
    }
  }

  const chapterNum = session.chapterCount;
  const correctionsNote = corrections
    ? `\n\nINSTRUCTIONS DE CORRECTION À RESPECTER POUR LA SUITE : ${corrections}`
    : "";

  const userMessage = brief
    ? `Écris le Chapitre ${chapterNum} avec ce brief : ${brief}. Développe-le en détail.${correctionsNote}${notionContext}`
    : `Continue l'histoire et écris le Chapitre ${chapterNum} en suivant logiquement les événements précédents. Sois très détaillé.${correctionsNote}${notionContext}`;

  session.messages.push({ role: "user", content: userMessage });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await runAgent(session.messages, async (event) => {
      send(event);
      if (event.type === "tool_result" && event.name === "create_chapter_page") {
        session.chapterCount++;
        await saveSession(sessionId, session);
      }
    });
    await saveSession(sessionId, session);
  } catch (err) {
    send({ type: "error", message: err.message });
  }

  res.end();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Start Server ─────────────────────────────────────────────────

connectMongo().then(() => {
  app.listen(3000, () => {
    console.log("🚀 Agent Story lancé sur http://localhost:3000");
    console.log("📋 Assure-toi d'avoir défini :");
    console.log("   ANTHROPIC_API_KEY");
    console.log("   NOTION_TOKEN");
    console.log("   NOTION_PARENT_PAGE_ID");
    console.log("   MONGODB_URI");
  });
}).catch(err => {
  console.error("❌ Erreur MongoDB:", err.message);
  process.exit(1);
});
