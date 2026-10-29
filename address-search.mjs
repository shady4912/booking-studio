function firstValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

export function formatAddressFeature(feature) {
  const properties = feature?.properties;
  if (!properties || typeof properties !== "object") return null;

  const street = firstValue(properties.street);
  const address = [firstValue(properties.housenumber), street].filter(Boolean).join(" ") ||
    firstValue(properties.name);
  if (!address) return null;

  const title = firstValue(properties.name, address);
  const city = firstValue(
    properties.city,
    properties.town,
    properties.village,
    properties.municipality,
    properties.locality,
  );
  const postcode = firstValue(properties.postcode, properties.postalcode);
  const details = [
    address === title ? "" : address,
    firstValue(properties.district, properties.suburb),
    city,
    postcode,
    firstValue(properties.country),
  ].filter((value, index, values) =>
    value && values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index,
  );

  return {
    id: `${properties.osm_type || "place"}:${properties.osm_id || address}`,
    title,
    details: details.join(", "),
    address,
    city,
    postcode,
  };
}
