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

// ── Verrou MongoDB anti-doublon ───────────────────────────────────
// Pose un verrou atomique sur la session pendant l'écriture d'un chapitre.
// Retourne true si le verrou a été acquis, false si déjà verrouillé.
async function acquireChapterLock(sessionId) {
  const result = await sessionsCollection.findOneAndUpdate(
    { sessionId, writingChapter: { $ne: true } },
    { $set: { writingChapter: true, writingChapterSince: new Date() } },
    { returnDocument: "after" }
  );
  return result !== null;
}

async function releaseChapterLock(sessionId) {
  await sessionsCollection.updateOne(
    { sessionId },
    { $unset: { writingChapter: "", writingChapterSince: "" } }
  );
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

function extractNotionId(url) {
  if (/^[a-f0-9]{32}$/.test(url)) return url;
  const match = url.match(/([a-f0-9]{32})/);
  return match ? match[1] : null;
}

async function readBlockContent(blockId) {
  const data = await notionRequest(`/blocks/${blockId}/children`);
  let content = "";
  for (const block of data.results || []) {
    if (block.type === "paragraph") {
      const text = block.paragraph?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += text + "\n\n";
    } else if (["heading_1", "heading_2", "heading_3"].includes(block.type)) {
      const text = block[block.type]?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `### ${text}\n\n`;
    } else if (block.type === "bulleted_list_item") {
      const text = block.bulleted_list_item?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `- ${text}\n`;
    } else if (block.type === "callout") {
      const text = block.callout?.rich_text?.map(r => r.text?.content).join("") || "";
      if (text) content += `> ${text}\n\n`;
    }
  }
  return content;
}

async function readNotionPageContent(pageId) {
  try {
    console.log('LECTURE PAGE NOTION:', pageId);
    const page = await notionRequest(`/pages/${pageId}`);
    const title = page.properties?.title?.title?.[0]?.text?.content ||
                  page.properties?.Name?.title?.[0]?.text?.content || "Page sans titre";
    console.log('TITRE PAGE:', title);

    const blocksData = await notionRequest(`/blocks/${pageId}/children`);
    console.log('TYPES DE BLOCS:', blocksData.results?.map(b => b.type));

    let content = `# ${title}\n\n`;

    for (const block of blocksData.results || []) {
      if (block.type === "paragraph") {
        const text = block.paragraph?.rich_text?.map(r => r.text?.content).join("") || "";
        if (text) content += text + "\n\n";
      } else if (["heading_1", "heading_2", "heading_3"].includes(block.type)) {
        const text = block[block.type]?.rich_text?.map(r => r.text?.content).join("") || "";
        if (text) content += `## ${text}\n\n`;
      } else if (block.type === "bulleted_list_item") {
        const text = block.bulleted_list_item?.rich_text?.map(r => r.text?.content).join("") || "";
        if (text) content += `- ${text}\n`;
      } else if (block.type === "callout") {
        const text = block.callout?.rich_text?.map(r => r.text?.content).join("") || "";
        if (text) content += `> ${text}\n\n`;
      } else if (block.type === "child_page") {
        const subPageTitle = block.child_page?.title || "Sous-page";
        content += `## ${subPageTitle}\n\n`;
        content += await readBlockContent(block.id);
      } else if (block.type === "child_database") {
        const dbTitle = block.child_database?.title || "Base de données";
        content += `## ${dbTitle}\n\n`;

        const dbContent = await notionRequest(`/databases/${block.id}/query`, "POST", {});

        const activeItems = (dbContent.results || []).filter(item => {
          const actifProp = item.properties?.["Actif"];
          return actifProp?.checkbox === true;
        });

        console.log(`BASE "${dbTitle}" — ${activeItems.length} entrée(s) active(s) sur ${dbContent.results?.length || 0}`);

        for (const item of activeItems) {
          const name = Object.values(item.properties).find(p => p.type === "title")?.title?.[0]?.text?.content || "";
          if (!name) continue;

          content += `### ${name}\n`;

          for (const [key, prop] of Object.entries(item.properties)) {
            if (key === "Actif") continue;
            if (prop.type === "rich_text" && prop.rich_text?.length > 0) {
              const val = prop.rich_text.map(r => r.text?.content).join("");
              if (val) content += `**${key}** : ${val}\n`;
            } else if (prop.type === "select" && prop.select) {
              content += `**${key}** : ${prop.select.name}\n`;
            } else if (prop.type === "checkbox") {
              // skip
            }
          }

          const itemBlocks = await notionRequest(`/blocks/${item.id}/children`);
          for (const b of itemBlocks.results || []) {
            if (b.type === "child_page") {
              content += await readBlockContent(b.id);
            } else if (b.type === "paragraph") {
              const text = b.paragraph?.rich_text?.map(r => r.text?.content).join("") || "";
              if (text) content += text + "\n";
            }
          }
          content += "\n";
        }
      }
    }

    console.log('CONTENU EXTRAIT (800 premiers chars):', content.slice(0, 800));
    return content.slice(0, 12000);
  } catch (e) {
    console.error('ERREUR LECTURE PAGE:', e.message);
    return "";
  }
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
    description: "Rédige un chapitre complet et le crée dans Notion. NE PAS appeler plus d'une fois par session — un seul chapitre par appel.",
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

async function runAgent(messages, onEvent, sessionId = null) {
  function trimHistory(msgs, keep = 20) {
    if (msgs.length <= keep + 1) return msgs;
    const first = msgs[0];
    let candidates = msgs.slice(-keep);
    while (candidates.length > 0) {
      const firstCandidate = candidates[0];
      const content = firstCandidate.content;
      const hasToolResult = Array.isArray(content)
        ? content.some(b => b.type === "tool_result")
        : false;
      if (!hasToolResult) break;
      candidates = candidates.slice(1);
    }
    return [first, ...candidates];
  }

  // Flag mémoire (protection intra-process)
  let chapterCreatedThisRun = false;

  const systemPrompt = `Tu es un agent créatif spécialisé dans l'écriture de romans détaillés. 
Tu génères des histoires riches, immersives et bien développées, puis tu les structures automatiquement dans Notion.

RÈGLE ABSOLUE SUR LES PERSONNAGES ET LEURS POUVOIRS :
- Chaque personnage a un pouvoir UNIQUE et FIXE défini dans sa fiche — ne jamais l'inventer, le modifier ou l'attribuer à un autre personnage
- Les pouvoirs de départ sont : Sesno = perception énergétique, Kalo = télépathie courte portée, Caën = densification osseuse, Rho = manipulation des fréquences sonores, Mira = vision thermique
- Les pouvoirs ne peuvent JAMAIS évoluer ou changer sans instruction explicite de l'utilisateur dans le brief du chapitre
- SEUL l'utilisateur peut faire évoluer un pouvoir, UNIQUEMENT via le brief
- Ne JAMAIS inventer un nouveau pouvoir pour un personnage existant

RÈGLES IMPORTANTES :
- Chaque chapitre doit être LONG et DÉTAILLÉ (minimum 1200-1500 mots), avec des dialogues, descriptions d'ambiance, pensées des personnages
- Pour les personnages PRINCIPAUX et SECONDAIRES : décris leur physique, leur psychologie et leurs contradictions internes
- Décris les lieux en détail AVANT d'y faire entrer les personnages : ambiance, sons, odeurs, lumières, température
- Chaque première apparition d'un personnage dans un chapitre doit inclure une description physique
- Utilise des dialogues riches et révélateurs de caractère
- Ne jamais précipiter les événements clés
- Un chapitre ne doit pas couvrir plus de 2-3 événements majeurs
- Pour chaque chapitre, utilise create_chapter_page UNE SEULE FOIS — ne jamais l'appeler deux fois
- Garde la cohérence narrative entre les chapitres

RÈGLES DE STYLE :
- Ne JAMAIS répéter la même formulation pour exprimer une idée
- Montre plutôt que tu ne dis
- Varie les points de vue narratifs

Tu dois TOUJOURS appeler les outils Notion, ne jamais juste afficher le texte sans le sauvegarder.`;

  while (true) {
    const trimmedMessages = trimHistory(messages, 20);

    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8000,
      system: systemPrompt,
      tools,
      messages: trimmedMessages,
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

        // Double protection anti-doublon : flag mémoire + verrou MongoDB
        if (toolUse.name === "create_chapter_page") {
          if (chapterCreatedThisRun) {
            console.warn("⚠️ Doublon create_chapter_page bloqué (flag mémoire)");
            const blockedResult = { success: false, error: "Chapitre déjà créé dans cette session. Ne pas appeler create_chapter_page une deuxième fois." };
            onEvent({ type: "tool_error", name: toolUse.name, error: blockedResult.error });
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(blockedResult) });
            continue;
          }
          // Verrou MongoDB si on a un sessionId
          if (sessionId) {
            const locked = await acquireChapterLock(sessionId);
            if (!locked) {
              console.warn("⚠️ Doublon create_chapter_page bloqué (verrou MongoDB)");
              const blockedResult = { success: false, error: "Un chapitre est déjà en cours de création pour cette session." };
              onEvent({ type: "tool_error", name: toolUse.name, error: blockedResult.error });
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(blockedResult) });
              continue;
            }
          }
        }

        onEvent({ type: "tool", name: toolUse.name, input: toolUse.input });

        let result;
        try {
          if (toolUse.name === "setup_story_structure") {
            result = await setupStoryStructure(toolUse.input);
          } else if (toolUse.name === "create_chapter_page") {
            result = await createChapterPage(toolUse.input);
            if (result.success) {
              chapterCreatedThisRun = true;
              // Le verrou sera libéré en fin de runAgent
            }
          } else if (toolUse.name === "add_character") {
            result = await addCharacter(toolUse.input);
          }
          onEvent({ type: "tool_result", name: toolUse.name, result });
        } catch (err) {
          result = { success: false, error: err.message };
          if (toolUse.name === "create_chapter_page" && sessionId) {
            await releaseChapterLock(sessionId);
          }
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

  // Libérer le verrou en fin d'exécution
  if (sessionId) await releaseChapterLock(sessionId);
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

app.delete("/api/sessions/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  await sessionsCollection.deleteOne({ sessionId });
  res.json({ success: true });
});

app.post("/api/start", async (req, res) => {
  const { storyBrief, notionPageUrl } = req.body;
  const sessionId = Date.now().toString();

  let notionContext = "";
  if (notionPageUrl) {
    try {
      const pageId = extractNotionId(notionPageUrl);
      const pageContent = await readNotionPageContent(pageId);
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
      if (event.type === "tool_result" && event.name === "create_chapter_page" && event.result?.success) {
        sessionData.chapterCount++;
        await saveSession(sessionId, sessionData);
      }
    }, sessionId);
    sessionData.messages = messages;
    await saveSession(sessionId, sessionData);
    send({ type: "session", sessionId });
  } catch (err) {
    await releaseChapterLock(sessionId);
    send({ type: "error", message: err.message });
  }

  res.end();
});

app.post("/api/chapter", async (req, res) => {
  const { sessionId, brief, corrections, existingChapterUrl } = req.body;
  const session = await loadSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  // Refus immédiat si un chapitre est déjà en cours d'écriture
  if (session.writingChapter) {
    const since = session.writingChapterSince ? new Date(session.writingChapterSince) : null;
    const ageMinutes = since ? (Date.now() - since.getTime()) / 60000 : 0;
    // Verrou expiré après 10 minutes (sécurité si le serveur a crashé)
    if (ageMinutes < 10) {
      return res.status(409).json({ error: "Un chapitre est déjà en cours de génération. Patiente quelques instants." });
    }
    // Verrou expiré — on le libère et on continue
    await releaseChapterLock(sessionId);
  }

  let notionContext = "";
  if (session.chaptersDbId) {
    try {
      const chapters = await readChaptersFromNotion(session.chaptersDbId);
      if (chapters.length > 0) {
        notionContext = `\n\nVoici la version ACTUELLE des chapitres dans Notion :\n` +
          chapters.map(c => `--- Chapitre ${c.num} : "${c.title}" ---\nRésumé : ${c.summary}\nExtrait : ${c.content.slice(0, 1500)}`).join("\n\n");
      }
    } catch (e) {
      console.log("Impossible de lire Notion:", e.message);
    }
  }

  let existingChapterContext = "";
  if (existingChapterUrl) {
    try {
      const pageId = extractNotionId(existingChapterUrl);
      const chapterContent = await readBlockContent(pageId);
      existingChapterContext = `\n\nL'utilisateur a écrit ou fourni le chapitre suivant — continue l'histoire EN PARTANT de ce chapitre :\n\n${chapterContent.slice(0, 8000)}`;
    } catch (e) {
      console.log("Impossible de lire le chapitre existant:", e.message);
    }
  }

  const chapterNum = session.chapterCount;
  const correctionsNote = corrections ? `\n\nINSTRUCTIONS DE CORRECTION : ${corrections}` : "";

  const userMessage = existingChapterUrl
    ? `Écris le Chapitre ${chapterNum} en continuant directement après le chapitre existant fourni.${correctionsNote}${existingChapterContext}${notionContext}`
    : brief
    ? `Écris le Chapitre ${chapterNum} avec ce brief : ${brief}. Développe-le en détail.${correctionsNote}${notionContext}`
    : `Continue l'histoire et écris le Chapitre ${chapterNum} en suivant logiquement les événements précédents.${correctionsNote}${notionContext}`;

  session.messages.push({ role: "user", content: userMessage });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await runAgent(session.messages, async (event) => {
      send(event);
      if (event.type === "tool_result" && event.name === "create_chapter_page" && event.result?.success) {
        session.chapterCount++;
        await saveSession(sessionId, session);
      }
    }, sessionId);
    await saveSession(sessionId, session);
  } catch (err) {
    await releaseChapterLock(sessionId);
    send({ type: "error", message: err.message });
  }

  res.end();
});

app.post("/api/delete-last-chapter", async (req, res) => {
  const { sessionId, brief, corrections } = req.body;
  const session = await loadSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    if (session.chaptersDbId) {
      const chapters = await readChaptersFromNotion(session.chaptersDbId);
      if (chapters.length > 0) {
        const lastChapter = chapters[chapters.length - 1];
        const dbContent = await notionRequest(`/databases/${session.chaptersDbId}/query`, "POST", {
          sorts: [{ property: "Numéro", direction: "descending" }],
          page_size: 1
        });
        if (dbContent.results?.length > 0) {
          const pageId = dbContent.results[0].id;
          await notionRequest(`/pages/${pageId}`, "PATCH", { archived: true });
          send({ type: "tool_result", name: "delete_chapter", result: { success: true, message: `Chapitre ${lastChapter.num} supprimé !` } });
        }
      }
    }

    if (session.chapterCount > 1) session.chapterCount--;

    const lastToolResultIdx = session.messages.map(m => m.role).lastIndexOf('user');
    if (lastToolResultIdx > 0) {
      session.messages = session.messages.slice(0, lastToolResultIdx - 1);
    }

    await saveSession(sessionId, session);

    const chapterNum = session.chapterCount;
    const correctionsNote = corrections ? `\n\nCORRECTIONS : ${corrections}` : "";
    const userMessage = brief
      ? `Réécris le Chapitre ${chapterNum} avec ce brief : ${brief}.${correctionsNote}`
      : `Réécris le Chapitre ${chapterNum} différemment, en restant cohérent avec les chapitres précédents.${correctionsNote}`;

    session.messages.push({ role: "user", content: userMessage });

    await runAgent(session.messages, async (event) => {
      send(event);
      if (event.type === "tool_result" && event.name === "create_chapter_page" && event.result?.success) {
        session.chapterCount++;
        await saveSession(sessionId, session);
      }
    }, sessionId);
    await saveSession(sessionId, session);
  } catch (err) {
    await releaseChapterLock(sessionId);
    send({ type: "error", message: err.message });
  }

  res.end();
});

app.post("/api/illustrations", async (req, res) => {
  const { chapterUrl, types } = req.body;

  try {
    const pageId = extractNotionId(chapterUrl);
    const chapterContent = await readBlockContent(pageId);
    if (!chapterContent) return res.json({ error: "Impossible de lire le chapitre" });

    const typeInstructions = [];
    if (types.includes('scenes')) typeInstructions.push("3 scènes clés du chapitre");
    if (types.includes('portraits')) typeInstructions.push("2 portraits de personnages présents dans le chapitre");
    if (types.includes('ambiances')) typeInstructions.push("2 ambiances ou lieux décrits dans le chapitre");

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `Tu es un expert en génération de prompts pour Leonardo AI. 
        
Lis ce chapitre et génère des prompts d'illustration optimisés pour Leonardo AI.

CHAPITRE :
${chapterContent.slice(0, 6000)}

Génère exactement : ${typeInstructions.join(", ")}.

L'univers est une dystopie industrielle sombre (style Blade Runner / Dark Souls). Ambiance : éclairage au Thorium (lueurs bleutées/orangées), mines profondes, métal et béton, atmosphère oppressive.

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks :
{
  "prompts": [
    {
      "type": "Scène clé / Portrait / Ambiance",
      "description": "Description courte en français de ce qui est illustré",
      "prompt": "Le prompt en anglais optimisé pour Leonardo AI, très détaillé, avec style artistique"
    }
  ]
}`
      }]
    });

    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    console.error("Erreur illustrations:", err.message);
    res.json({ error: err.message });
  }
});

app.post("/api/sync-chapters/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = await loadSession(sessionId);
  if (!session || !session.chaptersDbId)
    return res.json({ success: false, error: "Session ou base chapitres introuvable" });

  try {
    const dbContent = await notionRequest(`/databases/${session.chaptersDbId}/query`, "POST", {});
    const count = (dbContent.results || []).length;
    session.chapterCount = count + 1;
    await saveSession(sessionId, session);
    res.json({ success: true, chapterCount: count });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/api/chapters/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = await loadSession(sessionId);
  if (!session || !session.chaptersDbId) return res.json({ chapters: [] });

  try {
    const dbContent = await notionRequest(`/databases/${session.chaptersDbId}/query`, "POST", {
      sorts: [{ property: "Numéro", direction: "ascending" }]
    });

    const chapters = (dbContent.results || []).map(page => ({
      id: page.id,
      num: page.properties?.Numéro?.number,
      title: page.properties?.Titre?.title?.[0]?.text?.content || "Sans titre",
      summary: page.properties?.Résumé?.rich_text?.[0]?.text?.content || "",
      url: page.url
    }));

    res.json({ chapters });
  } catch (err) {
    res.json({ chapters: [], error: err.message });
  }
});

app.delete("/api/chapters/:pageId", async (req, res) => {
  const { pageId } = req.params;
  try {
    await notionRequest(`/pages/${pageId}`, "PATCH", { archived: true });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api/reorder-chapter", async (req, res) => {
  const { sessionId, from, to } = req.body;
  const session = await loadSession(sessionId);
  if (!session) return res.status(404).json({ error: "Session introuvable" });

  try {
    const dbContent = await notionRequest(`/databases/${session.chaptersDbId}/query`, "POST", {
      sorts: [{ property: "Numéro", direction: "ascending" }]
    });

    const pages = dbContent.results || [];
    const fromPage = pages.find(p => p.properties?.Numéro?.number === from);
    if (!fromPage) return res.json({ success: false, error: `Chapitre ${from} introuvable` });

    const direction = from < to ? 1 : -1;
    const range = pages.filter(p => {
      const num = p.properties?.Numéro?.number;
      return direction > 0 ? num > from && num <= to : num >= to && num < from;
    });

    for (const page of range) {
      const currentNum = page.properties?.Numéro?.number;
      await notionRequest(`/pages/${page.id}`, "PATCH", {
        properties: { Numéro: { number: currentNum - direction } }
      });
    }

    await notionRequest(`/pages/${fromPage.id}`, "PATCH", {
      properties: { Numéro: { number: to } }
    });

    res.json({ success: true, message: `Chapitre ${from} déplacé à la position ${to} ✓` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api/insert-chapter", async (req, res) => {
  const { sessionId, afterChapter, brief } = req.body;
  const session = await loadSession(sessionId);
  if (!session) return res.status(404).json({ error: "Session introuvable" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const chapters = await readChaptersFromNotion(session.chaptersDbId);
    const chapterBefore = chapters.find(c => c.num === afterChapter);
    const chapterAfter = chapters.find(c => c.num === afterChapter + 1);

    if (!chapterBefore) {
      send({ type: "error", message: `Chapitre ${afterChapter} introuvable` });
      return res.end();
    }

    const dbContent = await notionRequest(`/databases/${session.chaptersDbId}/query`, "POST", {
      sorts: [{ property: "Numéro", direction: "descending" }]
    });

    for (const page of dbContent.results || []) {
      const num = page.properties?.Numéro?.number;
      if (num > afterChapter) {
        await notionRequest(`/pages/${page.id}`, "PATCH", {
          properties: { Numéro: { number: num + 1 } }
        });
      }
    }

    send({ type: "text", text: `Chapitres renumérotés. Écriture du chapitre ${afterChapter + 1}…` });

    const insertContext = `
Tu dois écrire un chapitre qui s'insère ENTRE deux chapitres existants.

CHAPITRE PRÉCÉDENT (${afterChapter}) — résumé et fin :
${chapterBefore.summary}
${chapterBefore.content.slice(-1500)}

${chapterAfter ? `CHAPITRE SUIVANT (${afterChapter + 2}) — début :
${chapterAfter.summary}
${chapterAfter.content.slice(0, 1500)}

Le nouveau chapitre doit faire le lien naturel entre ces deux chapitres.` : ''}`;

    const userMessage = brief
      ? `Écris le Chapitre ${afterChapter + 1} avec ce brief : ${brief}. Il doit s'insérer naturellement entre les chapitres ${afterChapter} et ${afterChapter + 2}.${insertContext}`
      : `Écris le Chapitre ${afterChapter + 1} qui s'insère naturellement entre les chapitres ${afterChapter} et ${afterChapter + 2}.${insertContext}`;

    const insertMessages = [...session.messages, { role: "user", content: userMessage }];

    await runAgent(insertMessages, async (event) => {
      send(event);
      if (event.type === "tool_result" && event.name === "create_chapter_page" && event.result?.success) {
        session.chapterCount++;
        await saveSession(sessionId, session);
      }
    }, sessionId);

    await saveSession(sessionId, session);
  } catch (err) {
    await releaseChapterLock(sessionId);
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
