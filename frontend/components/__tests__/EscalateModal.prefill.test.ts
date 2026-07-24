import { nameFromEmail, readSaved, saveContact, SAVED_KEY } from "../EscalateModal";

beforeEach(() => localStorage.clear());

describe("support-request prefill", () => {
  it("guesses a name from the email local part", () => {
    expect(nameFromEmail("ana.lopez@empresa.com")).toBe("Ana Lopez");
    expect(nameFromEmail("santiago_luna-b@x.mx")).toBe("Santiago Luna B");
    expect(nameFromEmail("soporte@x.mx")).toBe("Soporte");
    expect(nameFromEmail(undefined)).toBe("");
  });

  it("round-trips what the user last sent", () => {
    saveContact({ name: "Ana", email: "ana@x.mx", phone: "5512345678" });
    expect(readSaved()).toEqual({ name: "Ana", email: "ana@x.mx", phone: "5512345678" });
  });

  it("survives missing or corrupt storage", () => {
    expect(readSaved()).toEqual({});
    localStorage.setItem(SAVED_KEY, "{not json");
    expect(readSaved()).toEqual({});
  });
});
