import { Router } from "express";
import { validateCoordinates } from "../lib/geo";

const router = Router();

router.get("/reverse-geocode", async (req, res) => {
  const { latitude, longitude } = req.query;

  if (!latitude || !longitude) {
    res.status(400).json({ error: "Missing latitude or longitude" });
    return;
  }

  const lat = Number(latitude);
  const lng = Number(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng) || !validateCoordinates(lat, lng)) {
    res.status(400).json({ error: "Invalid coordinates" });
    return;
  }

  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      res.status(response.status).json({ error: "Failed to fetch address from geocoding service" });
      return;
    }

    const data = await response.json();

    const responseData = {
      city: data.city || data.locality || "",
      region: data.principalSubdivision || "",
      countryCode: data.countryCode || "",
      countryName: data.countryName || "",
      latitude: data.latitude || lat,
      longitude: data.longitude || lng,
      address_line1: data.locality || data.city || "",
      postal_code: data.postcode || "",
    };

    res.json({ success: true, data: responseData });
  } catch (error) {
    console.error("[GeoRouter] reverse-geocode error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
