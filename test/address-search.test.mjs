import test from "node:test";
import assert from "node:assert/strict";
import { formatAddressFeature } from "../address-search.mjs";

test("formats a Photon street feature with house number, city, and postcode", () => {
  assert.deepEqual(formatAddressFeature({
    properties: {
      osm_type: "W",
      osm_id: 123,
      name: "Musterstraße",
      street: "Musterstraße",
      housenumber: "12",
      district: "Mitte",
      city: "Berlin",
      postcode: "10115",
      country: "Germany",
    },
  }), {
    id: "W:123",
    title: "Musterstraße",
    details: "12 Musterstraße, Mitte, Berlin, 10115, Germany",
    address: "12 Musterstraße",
    city: "Berlin",
    postcode: "10115",
  });
});

test("uses a place name when Photon has no street and supports town/postalcode fields", () => {
  assert.deepEqual(formatAddressFeature({
    properties: {
      name: "Example Place",
      town: "Example Town",
      postalcode: "12345",
      country: "Germany",
    },
  }), {
    id: "place:Example Place",
    title: "Example Place",
    details: "Example Town, 12345, Germany",
    address: "Example Place",
    city: "Example Town",
    postcode: "12345",
  });
});

test("ignores Photon features without a usable place name or street", () => {
  assert.equal(formatAddressFeature({ properties: { country: "Germany" } }), null);
  assert.equal(formatAddressFeature(null), null);
});
