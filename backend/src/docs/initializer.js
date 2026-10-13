/**
 * Initializes the Swagger UI once the page has finished loading.
 * The OpenAPI document is served from /openapi.json and rendered in
 * the #swagger-ui container using the standalone layout.
 */
/* global SwaggerUIBundle, SwaggerUIStandalonePreset */
window.addEventListener("load", () => {
  SwaggerUIBundle({
    // Load the generated OpenAPI schema from the backend.
    url: "/openapi.json",
    // Mount Swagger UI into the page element with this DOM id.
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: "StandaloneLayout",
    withCredentials: true,
    persistAuthorization: false,
    // Restrict submit actions to read-only GET requests in the docs UI.
    supportedSubmitMethods: ["get"],
    // Disable remote schema validation to keep offline/local docs behavior predictable.
    validatorUrl: null,
  });
});
