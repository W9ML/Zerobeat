/** A callsign's page on QRZ.com. The slash in PJ4/K1ABC stays a slash: QRZ answers an encoded one with a 404. */
export const qrzUrl = (call: string) => `https://www.qrz.com/db/${call.trim().toUpperCase().split("/").map(encodeURIComponent).join("/")}`;
