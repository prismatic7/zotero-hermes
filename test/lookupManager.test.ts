import { expect } from "chai";
import {
  crossrefTypeToZotero,
  isDoiLike,
  LookupManager,
  normaliseDoi,
} from "../src/modules/hermes/LookupManager";
import type Addon from "../src/addon";

function mockAddon(): Addon {
  return { log: () => {} } as unknown as Addon;
}

/**
 * Fixtures are trimmed copies of responses observed live from the real APIs on
 * 2026-10-04. Keeping them verbatim matters: a fixture invented from the docs
 * would let a wrong field path pass.
 */
const CROSSREF_WORK = {
  message: {
    DOI: "10.21810/aer.v1i1.5379",
    type: "journal-article",
    title: [
      "Political Acoustic Ecology: On the Role of Political Ecology in Soundscape Studies",
    ],
    author: [{ given: "Arnold", family: "Scheidel" }],
    issued: { "date-parts": [[2023, 11, 21]] },
    "container-title": ["Acoustic Ecology Review"],
    volume: "1",
    page: "12-30",
    publisher: "Simon Fraser University Library",
    "publisher-location": "Vancouver",
    ISSN: ["2563-5123"],
    URL: "https://doi.org/10.21810/aer.v1i1.5379",
  },
};

const CROSSREF_SEARCH = {
  message: {
    items: [
      {
        DOI: "10.21810/aer.v6i2.6045",
        type: "journal-article",
        title: ["Acoustic Ecology Considered as a Connotation"],
        issued: { "date-parts": [[2024]] },
      },
      {
        DOI: "10.12681/eadd/37683",
        type: "dissertation",
        title: ["Acoustic ecology of avians"],
        issued: { "date-parts": [[2016]] },
      },
    ],
  },
};

const S2_CITATIONS = {
  offset: 0,
  data: [
    {
      citingPaper: {
        paperId: "dbca49723bf433d573bc3a590e199c10599b174b",
        externalIds: { DOI: "10.1002/pan3.70391", CorpusId: 290326274 },
        title:
          "Public perceptions of anthropogenic and natural sounds: Disparities in soundscapes and corresponding sense of place",
        venue: "People and Nature",
        year: 2026,
      },
    },
    {
      citingPaper: {
        paperId: "1f98d179f2e2f1ae5fee4c27d6ee42dde64f6741",
        externalIds: { DOI: "10.61996/cultural.v3i2.110", CorpusId: 282092878 },
        title: "The Acoustic City: Sonorous Landscapes, Urban Memory",
        venue: "Enigma in Cultural",
        year: 2025,
      },
    },
  ],
};

/** Records every URL requested, so pacing/endpoint choices are assertable. */
function stubHttp(
  handler: (url: string) => { status: number; response?: unknown },
) {
  const urls: string[] = [];
  return {
    urls,
    httpRequest: async (_method: string, url: string) => {
      urls.push(url);
      const result = handler(url);
      return result as { status: number; responseText?: string };
    },
  };
}

describe("LookupManager helpers", function () {
  it("normalises DOI resolver prefixes and case", function () {
    expect(normaliseDoi("https://doi.org/10.1234/ABC")).to.equal("10.1234/abc");
    expect(normaliseDoi("http://dx.doi.org/10.1234/x")).to.equal("10.1234/x");
    expect(normaliseDoi("doi: 10.1234/x")).to.equal("10.1234/x");
    expect(normaliseDoi(" 10.1234/x ")).to.equal("10.1234/x");
  });

  it("recognises DOI-shaped strings only", function () {
    expect(isDoiLike("10.1234/abc")).to.equal(true);
    expect(isDoiLike("https://doi.org/10.1234/abc")).to.equal(true);
    expect(isDoiLike("not a doi")).to.equal(false);
    expect(isDoiLike("10.12/x")).to.equal(false);
    expect(isDoiLike("")).to.equal(false);
  });

  it("maps CrossRef types onto Zotero item types", function () {
    expect(crossrefTypeToZotero("journal-article")).to.equal("journalArticle");
    expect(crossrefTypeToZotero("book-chapter")).to.equal("bookSection");
    expect(crossrefTypeToZotero("dissertation")).to.equal("thesis");
    expect(crossrefTypeToZotero("posted-content")).to.equal("preprint");
    expect(crossrefTypeToZotero("dataset")).to.equal("dataset");
    // Unknown types must not crash or return empty — fall back visibly.
    expect(crossrefTypeToZotero(undefined)).to.equal("journalArticle");
    expect(crossrefTypeToZotero("something-new")).to.equal("journalArticle");
  });
});

describe("LookupManager.lookupDoi", function () {
  it("returns a normalised record from CrossRef", async function () {
    const { httpRequest } = stubHttp(() => ({
      status: 200,
      response: CROSSREF_WORK,
    }));
    const manager = new LookupManager(mockAddon());

    const record = await manager.lookupDoi("10.21810/aer.v1i1.5379", {
      httpRequest,
    });

    expect(record).to.not.be.null;
    expect(record!.source).to.equal("crossref");
    expect(record!.itemType).to.equal("journalArticle");
    expect(record!.title).to.include("Political Acoustic Ecology");
    expect(record!.creators).to.deep.equal([
      { firstName: "Arnold", lastName: "Scheidel", creatorType: "author" },
    ]);
    expect(record!.year).to.equal(2023);
    expect(record!.date).to.equal("2023-11-21");
    expect(record!.publicationTitle).to.equal("Acoustic Ecology Review");
    expect(record!.volume).to.equal("1");
    expect(record!.pages).to.equal("12-30");
    expect(record!.publisher).to.equal("Simon Fraser University Library");
    expect(record!.ISSN).to.equal("2563-5123");
  });

  it("accepts a DOI given as a URL", async function () {
    const { urls, httpRequest } = stubHttp(() => ({
      status: 200,
      response: CROSSREF_WORK,
    }));
    const manager = new LookupManager(mockAddon());

    const record = await manager.lookupDoi(
      "https://doi.org/10.21810/aer.v1i1.5379",
      { httpRequest },
    );

    expect(record).to.not.be.null;
    expect(urls[0]).to.include("/works/10.21810%2Faer.v1i1.5379");
  });

  it("falls back to DataCite when CrossRef has no such DOI", async function () {
    const { urls, httpRequest } = stubHttp((url) => {
      if (url.includes("crossref")) return { status: 404 };
      return {
        status: 200,
        response: {
          data: {
            attributes: {
              doi: "10.5281/zenodo.1234",
              titles: [{ title: "A Recorded Dataset" }],
              creators: [{ givenName: "Ada", familyName: "Lovelace" }],
              publicationYear: 2021,
              publisher: "Zenodo",
              types: { resourceTypeGeneral: "Dataset" },
              url: "https://zenodo.org/record/1234",
            },
          },
        },
      };
    });
    const manager = new LookupManager(mockAddon());

    const record = await manager.lookupDoi("10.5281/zenodo.1234", {
      httpRequest,
    });

    expect(urls).to.have.length(2);
    expect(urls[1]).to.include("datacite.org");
    expect(record!.source).to.equal("datacite");
    expect(record!.itemType).to.equal("dataset");
    expect(record!.publisher).to.equal("Zenodo");
    expect(record!.year).to.equal(2021);
  });

  it("returns null (not an error) when the DOI is unknown everywhere", async function () {
    const { httpRequest } = stubHttp(() => ({ status: 404 }));
    const manager = new LookupManager(mockAddon());

    const record = await manager.lookupDoi("10.9999/does-not-exist", {
      httpRequest,
    });

    expect(record).to.equal(null);
  });

  it("rejects a non-DOI string without making a request", async function () {
    const { urls, httpRequest } = stubHttp(() => ({ status: 200 }));
    const manager = new LookupManager(mockAddon());

    const record = await manager.lookupDoi("just a title", { httpRequest });

    expect(record).to.equal(null);
    expect(urls).to.have.length(0);
  });

  it("returns null rather than throwing when the request rejects", async function () {
    const manager = new LookupManager(mockAddon());

    const record = await manager.lookupDoi("10.1234/x", {
      httpRequest: async () => {
        throw new Error("network down");
      },
    });

    expect(record).to.equal(null);
  });
});

describe("LookupManager.findDoiByTitle", function () {
  it("picks the closest title match, not merely the first result", async function () {
    const { httpRequest } = stubHttp(() => ({
      status: 200,
      response: CROSSREF_SEARCH,
    }));
    const manager = new LookupManager(mockAddon());

    const record = await manager.findDoiByTitle("Acoustic ecology of avians", {
      httpRequest,
    });

    expect(record).to.not.be.null;
    expect(record!.doi).to.equal("10.12681/eadd/37683");
    expect(record!.itemType).to.equal("thesis");
  });

  it("returns null when nothing matches the title", async function () {
    const { httpRequest } = stubHttp(() => ({
      status: 200,
      response: CROSSREF_SEARCH,
    }));
    const manager = new LookupManager(mockAddon());

    const record = await manager.findDoiByTitle(
      "A completely unrelated study of underwater basket weaving",
      { httpRequest },
    );

    expect(record).to.equal(null);
  });

  it("returns null for an empty query without requesting", async function () {
    const { urls, httpRequest } = stubHttp(() => ({ status: 200 }));
    const manager = new LookupManager(mockAddon());

    expect(await manager.findDoiByTitle("   ", { httpRequest })).to.equal(null);
    expect(urls).to.have.length(0);
  });
});

describe("LookupManager.findCitingWorks", function () {
  it("returns the citing works with their DOIs", async function () {
    const { httpRequest } = stubHttp(() => ({
      status: 200,
      response: S2_CITATIONS,
    }));
    const manager = new LookupManager(mockAddon());

    const works = await manager.findCitingWorks("10.21810/aer.v1i1.5379", {
      httpRequest,
    });

    expect(works).to.have.length(2);
    expect(works[0].title).to.include("Public perceptions");
    expect(works[0].year).to.equal(2026);
    expect(works[0].venue).to.equal("People and Nature");
    expect(works[0].doi).to.equal("10.1002/pan3.70391");
  });

  it("marks citing works already in the library", async function () {
    const { httpRequest } = stubHttp(() => ({
      status: 200,
      response: S2_CITATIONS,
    }));
    const manager = new LookupManager(mockAddon());

    const works = await manager.findCitingWorks("10.21810/aer.v1i1.5379", {
      httpRequest,
      isInLibrary: (doi) => (doi === "10.1002/pan3.70391" ? { id: 99 } : null),
    });

    expect(works[0].inLibrary).to.equal(true);
    expect(works[0].existingItemID).to.equal(99);
    expect(works[1].inLibrary).to.equal(false);
  });

  it("treats Semantic Scholar's HTTP-200 error body as no results", async function () {
    // Observed live: S2 answers 200 with {error: "Paper with id ... not found"}
    // rather than a 404. Checking only the status would surface a bogus result.
    const { httpRequest } = stubHttp(() => ({
      status: 200,
      response: { error: "Paper with id DOI:10.1/x not found" },
    }));
    const manager = new LookupManager(mockAddon());

    const works = await manager.findCitingWorks("10.1/x", { httpRequest });

    expect(works).to.deep.equal([]);
  });

  it("returns [] for a malformed DOI without requesting", async function () {
    const { urls, httpRequest } = stubHttp(() => ({ status: 200 }));
    const manager = new LookupManager(mockAddon());

    const works = await manager.findCitingWorks("nonsense", { httpRequest });

    expect(works).to.deep.equal([]);
    expect(urls).to.have.length(0);
  });

  it("clamps the requested limit to the API's accepted range", async function () {
    const { urls, httpRequest } = stubHttp(() => ({
      status: 200,
      response: { data: [] },
    }));
    const manager = new LookupManager(mockAddon());

    await manager.findCitingWorks("10.1234/x", { httpRequest, limit: 5000 });
    expect(urls[0]).to.include("limit=100");

    urls.length = 0;
    await manager.findCitingWorks("10.1234/x", { httpRequest, limit: 0 });
    expect(urls[0]).to.include("limit=1");
  });

  it("sends an API key header only when one is configured", async function () {
    const seen: Array<Record<string, string>> = [];
    const httpRequest = async (
      _m: string,
      _u: string,
      options?: Record<string, unknown>,
    ) => {
      seen.push((options?.headers || {}) as Record<string, string>);
      return { status: 200, response: { data: [] } };
    };
    const manager = new LookupManager(mockAddon());

    await manager.findCitingWorks("10.1234/x", { httpRequest });
    expect(seen[0]["x-api-key"]).to.equal(undefined);

    await manager.findCitingWorks("10.1234/x", {
      httpRequest,
      semanticScholarApiKey: "secret-key",
    });
    expect(seen[1]["x-api-key"]).to.equal("secret-key");
  });
});
