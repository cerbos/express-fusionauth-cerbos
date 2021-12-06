import express from "express";
import { Cerbos } from "cerbos";
import expressSession from "express-session";
import cookieParser from "cookie-parser";
import { FusionAuthClient } from "@fusionauth/typescript-client";
import pkceChallenge from "pkce-challenge";
import path from "path";

import db from "./db.js";

// Set the Client ID and Client Secret from FusionAuth here:
const CLIENT_ID = "db29769a-6903-41ce-8af4-6601833a4805";
const CLIENT_SECRET = "RQkML-ov1efGWIZv3NEAUR47oBcp3dhk3AB8z6G3WoE";

const fusionAuthURL = process.env.FUSIONAUTH_HOST;
const redirectUrl = `http://localhost:${process.env.PORT}/auth/callback`;
const client = new FusionAuthClient("noapikeyneeded", fusionAuthURL);

console.log(`Connecting to Cerbos on ${process.env.CERBOS_HOST}`);
const cerbos = new Cerbos({
  hostname: process.env.CERBOS_HOST, // The Cerbos PDP instance
});

const app = express();

const __dirname = path.resolve();
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(
  expressSession({
    resave: false,
    saveUninitialized: false,
    secret: "fusionauth-node-example",
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.get("/logout", function (req, res, next) {
  req.session.destroy();
  res.redirect(302, "/");
});

app.get("/", function (req, res, next) {
  const stateValue =
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15);
  req.session.stateValue = stateValue;

  //generate the pkce challenge/verifier dict
  const pkce_pair = pkceChallenge();
  // Store the PKCE verifier in session
  req.session.verifier = pkce_pair["code_verifier"];
  const challenge = pkce_pair["code_challenge"];
  res.render("index", {
    user: req.session.user,
    title: "FusionAuth Example",
    clientId: CLIENT_ID,
    challenge,
    stateValue,
    fusionAuthURL,
    redirectUrl,
  });
});

app.get("/auth/callback", function (req, res, next) {
  const stateFromServer = req.query.state;
  if (stateFromServer !== req.session.stateValue) {
    console.log("State doesn't match. uh-oh.");
    console.log(
      "Saw: " + stateFromServer + ", but expected: " + req.session.stateValue
    );
    res.redirect(302, "/");
    return;
  }

  client
    .exchangeOAuthCodeForAccessTokenUsingPKCE(
      req.query.code,
      CLIENT_ID,
      CLIENT_SECRET,
      redirectUrl,
      req.session.verifier
    )
    .then((response) => {
      console.log(response.response.access_token);
      return client.retrieveUserUsingJWT(response.response.access_token);
    })
    .then((response) => {
      console.log(response.response.user);
      if (
        !response.response.user.registrations ||
        response.response.user.registrations.length == 0 ||
        response.response.user.registrations.filter(
          (reg) => reg.applicationId === CLIENT_ID
        ).length == 0
      ) {
        console.log("User not registered, not authorized.");
        res.redirect(302, "/");
        return;
      }
      const app = response.response.user.registrations.find(
        (reg) => reg.applicationId === CLIENT_ID
      );

      req.session.user = {
        id: response.response.user.id,
        firstName: response.response.user.firstName,
        lastName: response.response.user.lastName,
        email: response.response.user.email,
        roles: app.roles,
      };
    })

    // This code pushes the access and refresh tokens back to the browser as secure, HTTP-only cookies
    .then((response) => {
      res.redirect(302, "/");
    })
    .catch((err) => {
      console.log("in error");
      console.error(JSON.stringify(err));
    });
});

// READ
app.get("/contacts/:id", async (req, res) => {
  // load the contact
  const contact = db.findOne(req.params.id);
  if (!contact) {
    return res.status(404).json({ error: "Contact not found" });
  }

  // check user is authorized
  const allowed = await cerbos.check({
    principal: {
      id: req.session.user.id,
      roles: req.session.user.roles,
    },
    resource: {
      kind: "contact",
      instances: {
        [contact.id]: {
          attr: contact,
        },
      },
    },
    actions: ["read"],
  });

  // authorized for read action
  if (allowed.isAuthorized(contact.id, "read")) {
    return res.json(contact);
  } else {
    return res.status(403).json({ error: "Unauthorized" });
  }
});

// CREATE
app.post("/contacts/new", async (req, res) => {
  // check user is authorized
  const allowed = await cerbos.check({
    principal: {
      id: req.session.user.id,
      roles: req.session.user.roles,
    },
    resource: {
      kind: "contact",
      instances: {
        new: {},
      },
    },
    actions: ["create"],
  });

  // authorized for create action
  if (allowed.isAuthorized("new", "create")) {
    return res.json({ result: "Created contact" });
  } else {
    return res.status(403).json({ error: "Unauthorized" });
  }
});

// UPDATE
app.patch("/contacts/:id", async (req, res) => {
  const contact = db.findOne(req.params.id);
  if (!contact) {
    return res.status(404).json({ error: "Contact not found" });
  }

  const allowed = await cerbos.check({
    principal: {
      id: req.session.user.id,
      roles: req.session.user.roles,
    },
    resource: {
      kind: "contact",
      instances: {
        [contact.id]: {
          attr: contact,
        },
      },
    },
    actions: ["update"],
  });

  if (allowed.isAuthorized(req.params.id, "update")) {
    return res.json({
      result: `Updated contact ${req.params.id}`,
    });
  } else {
    return res.status(403).json({ error: "Unauthorized" });
  }
});

// DELETE
app.delete("/contacts/:id", async (req, res) => {
  const contact = db.findOne(req.params.id);
  if (!contact) {
    return res.status(404).json({ error: "Contact not found" });
  }

  const allowed = await cerbos.check({
    principal: {
      id: req.session.user.id,
      roles: req.session.user.roles,
    },
    resource: {
      kind: "contact",
      instances: {
        [contact.id]: {
          attr: contact,
        },
      },
    },
    actions: ["delete"],
  });

  if (allowed.isAuthorized(req.params.id, "delete")) {
    return res.json({
      result: `Contact ${req.params.id} deleted`,
    });
  } else {
    return res.status(403).json({ error: "Unauthorized" });
  }
});

// LIST
app.get("/contacts", async (req, res) => {
  // load the contacts
  const contacts = db.find(req.params.id);

  // check user is authorized
  const allowed = await cerbos.check({
    principal: {
      id: req.session.user.id,
      roles: req.session.user.roles,
    },
    resource: {
      kind: "contact",
      instances: contacts.reduce(function (result, item, index, array) {
        result[item.id] = item; //a, b, c
        return result;
      }, {}),
    },
    actions: ["list"],
  });

  // filter only those authorised
  const result = contacts.filter((c) => allowed.isAuthorized(c.id, "list"));

  // return the contact
  return res.json(result);
});

app.listen(process.env.PORT, () =>
  console.log(`Listening on port ${process.env.PORT}`)
);
