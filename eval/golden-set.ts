import type { GoldenDocument } from "./types";

/**
 * Hand-curation queue. Do not populate relationships from ledger claims or a
 * model response: read the stored source PDF and record every explicit
 * relationship with its evidence sentence, then mark the entry ready.
 */
export const goldenSet: GoldenDocument[] = [
  {
    documentId: "a44d2bff-5bda-4f0a-99a6-72497d58e0a9",
    company: "Ashok Leyland Limited",
    agency: "ICRA",
    difficulty: "medium",
    curationStatus: "needs_curation",
    relationships: [],
    notes: "Quote-mismatch diagnostic case.",
  },
  {
    documentId: "04312e65-a603-4f4a-b6e7-3778b84639eb",
    company: "Avanti Feeds Limited",
    agency: "India Ratings",
    difficulty: "medium",
    curationStatus: "needs_curation",
    relationships: [],
  },
  {
    documentId: "6fe8a7f7-0738-4211-bf08-e1782535c6b3",
    company: "Bharat Electronics Limited",
    agency: "ICRA",
    difficulty: "medium",
    curationStatus: "needs_curation",
    relationships: [],
    notes: "Quote-mismatch diagnostic case.",
  },
  {
    documentId: "68f0eaec-178c-430b-97dc-123f92c59073",
    company: "Cyient DLM Limited",
    agency: "CRISIL",
    difficulty: "medium",
    curationStatus: "needs_curation",
    relationships: [],
  },
  {
    documentId: "c4dbf63d-99c3-4f2b-8763-c588b5a7ec5e",
    company: "Sona BLW Precision Forgings Limited",
    agency: "India Ratings",
    difficulty: "medium",
    curationStatus: "needs_curation",
    relationships: [],
  },
  {
    documentId: "30ab97aa-450d-464d-b49c-3eead7e571fd",
    company: "Suzlon Energy Limited",
    agency: "ICRA",
    difficulty: "hard",
    curationStatus: "needs_curation",
    relationships: [],
    notes: "Low-yield, structure-heavy recall case.",
  },
  {
    documentId: "9b856f70-a59a-483d-bbd3-cddf69cd1edb",
    company: "Tata Motors Limited",
    agency: "CRISIL",
    difficulty: "hard",
    curationStatus: "needs_curation",
    relationships: [],
    notes: "Group-structure and table-derived quote case.",
  },
  {
    documentId: "8de01c46-dd33-4a5b-a55c-0a0274ed01ff",
    company: "Syrma SGS Technology Limited",
    agency: "India Ratings",
    difficulty: "medium",
    curationStatus: "needs_curation",
    relationships: [],
  },
  {
    documentId: "d1bffc88-5128-4137-b772-12f1faf8bc0b",
    company: "Hindustan Aeronautics Limited",
    agency: "CARE",
    difficulty: "medium",
    curationStatus: "blocked_no_stored_pdf",
    relationships: [],
    notes: "Static-imported CARE graph has no stored source PDF; add the immutable PDF before evaluation.",
  },
  {
    documentId: "eb50ac2a-6e12-4a27-b6c5-317d31cf705f",
    company: "Modison Limited",
    agency: "CARE",
    difficulty: "easy",
    curationStatus: "blocked_no_stored_pdf",
    relationships: [],
    notes: "Static-imported CARE graph has no stored source PDF; add the immutable PDF before evaluation.",
  },
];
