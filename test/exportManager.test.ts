import { expect } from "chai";
import { ExportManager } from "../src/modules/hermes/ExportManager";
import type { Conversation } from "../src/modules/hermes/ConversationManager";
import type { AttachedItem } from "../src/modules/hermes/ItemManager";

describe("ExportManager", function () {
  const mockAddon: any = {
    data: {
      hermes: {
        preferences: {
          get: (key: string, def: any) => def,
        },
      },
    },
    log: () => {},
  };

  it("should format markdown with valid YAML frontmatter, wikilinks, and zotero URIs", function () {
    const exporter = new ExportManager(mockAddon);
    const mockConversation: Conversation = {
      id: "conv_123",
      title: "Quantum Theory Discussion",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "What is quantum entanglement?",
          timestamp: 1690000000000,
        },
        {
          id: "m2",
          role: "assistant",
          content:
            "Quantum entanglement is a phenomenon where particles share quantum states.",
          timestamp: 1690000001000,
        },
      ],
      createdAt: 1690000000000,
      updatedAt: 1690000001000,
      allowedTools: null,
    };

    const mockItem: AttachedItem = {
      id: 101,
      key: "ABCDEF12",
      title:
        "Can Quantum-Mechanical Description of Physical Reality be Complete?",
      itemType: "journalArticle",
      creators: ["Albert Einstein", "Boris Podolsky", "Nathan Rosen"],
      date: "1935",
      abstract: "In a complete theory...",
      tags: ["physics", "quantum"],
      citekey: "Einstein1935",
      attachmentKey: "PDF999",
      doi: "10.1103/PhysRev.47.777",
    };

    const markdown = exporter.exportToMarkdown(mockConversation, [mockItem]);

    // Check YAML Frontmatter
    expect(markdown).to.include("---");
    expect(markdown).to.include('title: "Quantum Theory Discussion"');
    expect(markdown).to.include("tags:\n  - hermes\n  - zotero-chat");
    expect(markdown).to.include('citekey: "Einstein1935"');
    expect(markdown).to.include(
      'zotero_select_uri: "zotero://select/items/ABCDEF12"',
    );
    expect(markdown).to.include(
      'zotero_pdf_uri: "zotero://open-pdf/library/items/PDF999"',
    );

    // Check Attached Sources with wikilinks
    expect(markdown).to.include(
      "[[Can Quantum-Mechanical Description of Physical Reality be Complete?]]",
    );
    expect(markdown).to.include("(`@Einstein1935`)");
    expect(markdown).to.include(
      "[Open in Zotero](zotero://select/items/ABCDEF12)",
    );

    // Check Discussion Section
    expect(markdown).to.include("### 🧑 User\n\nWhat is quantum entanglement?");
    expect(markdown).to.include(
      "### 🤖 Hermes\n\nQuantum entanglement is a phenomenon",
    );
  });

  it("should generate valid Obsidian Canvas (.canvas) JSON graph with nodes and edges", function () {
    const exporter = new ExportManager(mockAddon);
    const mockConversation: Conversation = {
      id: "conv_canvas",
      title: "Neural Architectures Graph",
      messages: [],
      createdAt: 1690000000000,
      updatedAt: 1690000000000,
      allowedTools: null,
    };

    const item1: AttachedItem = {
      id: 1,
      key: "KEY1",
      title: "Attention Is All You Need",
      itemType: "conferencePaper",
      creators: ["Vaswani et al."],
      date: "2017",
      citekey: "vaswani2017attention",
      attachmentKey: "PDF1",
    };

    const item2: AttachedItem = {
      id: 2,
      key: "KEY2",
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      itemType: "conferencePaper",
      creators: ["Devlin et al."],
      date: "2018",
      citekey: "devlin2018bert",
      attachmentKey: "PDF2",
    };

    const canvasJson = exporter.exportToCanvas(mockConversation, [
      item1,
      item2,
    ]);
    const parsed = JSON.parse(canvasJson);

    expect(parsed).to.have.property("nodes").that.is.an("array");
    expect(parsed).to.have.property("edges").that.is.an("array");

    // Header node + 2 paper nodes = 3 nodes
    expect(parsed.nodes).to.have.lengthOf(3);
    const headerNode = parsed.nodes.find((n: any) => n.id === "root-header");
    expect(headerNode).to.exist;
    expect(headerNode.text).to.include("Neural Architectures Graph");

    const paper1Node = parsed.nodes.find((n: any) => n.id === "paper-KEY1");
    expect(paper1Node).to.exist;
    expect(paper1Node.text).to.include("[[Attention Is All You Need]]");
    expect(paper1Node.text).to.include("@vaswani2017attention");

    // Edges: 2 header edges + 1 chronological edge (2017 -> 2018)
    expect(parsed.edges).to.have.lengthOf(3);
    const chronoEdge = parsed.edges.find((e: any) => e.label === "precedes");
    expect(chronoEdge).to.exist;
    expect(chronoEdge.fromNode).to.equal("paper-KEY1");
    expect(chronoEdge.toNode).to.equal("paper-KEY2");
  });

  describe("annotation notes (B3)", function () {
    // Real Better BibTeX creators arrive as "Surname, Given"; Zotero renders
    // them that way for `getCreators()` on a normal author field.
    const item = {
      title: "Political Acoustic Ecology",
      key: "ABCD1234",
      creators: ["Scheidel, Walter", "Meyer, Birgit"],
      date: "2023",
      doi: "10.21810/aer.v1i1.5379",
      citekey: "scheidel2023political",
    };

    it("titles the note `Title — Author`, never the citekey", function () {
      const exporter = new ExportManager(mockAddon);
      const title = exporter.buildAnnotationNoteTitle(item);

      expect(title).to.equal("Political Acoustic Ecology — Scheidel");
      expect(title).to.not.include("scheidel2023political");
      // The separator is an em dash, not a hyphen.
      expect(title).to.include("\u2014");
    });

    it("strips a Better BibTeX year disambiguator from the surname", function () {
      const exporter = new ExportManager(mockAddon);
      const title = exporter.buildAnnotationNoteTitle({
        ...item,
        creators: ["Scheidel, Walter 2023"],
      });
      expect(title).to.equal("Political Acoustic Ecology — Scheidel");
    });

    it("falls back to the bare title when there is no creator", function () {
      const exporter = new ExportManager(mockAddon);
      expect(
        exporter.buildAnnotationNoteTitle({ ...item, creators: [] }),
      ).to.equal("Political Acoustic Ecology");
    });

    it("sanitises filename-illegal characters out of the title", function () {
      const exporter = new ExportManager(mockAddon);
      const title = exporter.buildAnnotationNoteTitle({
        ...item,
        title: 'Sound/Image: "A" <Study>',
      });
      expect(title).to.not.match(/[/\\?%*:|"<>]/);
      expect(title).to.include("Sound-Image");
    });

    it("puts the citekey in frontmatter and the body, not the note name", function () {
      const exporter = new ExportManager(mockAddon);
      const md = exporter.buildAnnotationNote(item, []);

      expect(md).to.include('citekey: "scheidel2023political"');
      // Aliased so search-by-citekey still resolves the note.
      expect(md).to.include('aliases:\n  - "scheidel2023political"');
      expect(md).to.include("`@scheidel2023political`");
      expect(md).to.include("zotero://select/items/ABCD1234");
      // ...but never the filename.
      expect(md.split("\n")[0]).to.not.include("citekey");
    });

    it("quotes highlights and comments but not the user's own notes", function () {
      const exporter = new ExportManager(mockAddon);
      const md = exporter.buildAnnotationNote(item, [
        {
          id: "ANN1",
          page: 4,
          type: "highlight",
          text: "The ear is a political organ.",
          comment: "Compare to Adorno",
          color: "#ffd400",
        },
        {
          id: "ANN2",
          page: 9,
          type: "note",
          text: "This whole section is really about listening as labour.",
        },
      ]);

      // Source text is a blockquote...
      expect(md).to.include("> The ear is a political organ.");
      // ...the user's note is not.
      expect(md).to.not.include(
        "> This whole section is really about listening",
      );
      expect(md).to.include(
        "This whole section is really about listening as labour.",
      );
      expect(md).to.include("💬 Compare to Adorno");
    });

    it("groups annotations by page regardless of input order", function () {
      const exporter = new ExportManager(mockAddon);
      const md = exporter.buildAnnotationNote(item, [
        { id: "B", page: 9, type: "highlight", text: "later" },
        { id: "A", page: 2, type: "highlight", text: "earlier" },
      ]);

      expect(md.indexOf("## Page 2")).to.be.lessThan(md.indexOf("## Page 9"));
    });

    it("says so plainly when there are no annotations", function () {
      const exporter = new ExportManager(mockAddon);
      const md = exporter.buildAnnotationNote(item, []);

      expect(md).to.include("*No annotations yet.*");
      // A note with no annotations must still be valid frontmatter.
      expect(md.startsWith("---\n")).to.equal(true);
      expect(md).to.include("annotation_count: 0");
    });
  });
});
