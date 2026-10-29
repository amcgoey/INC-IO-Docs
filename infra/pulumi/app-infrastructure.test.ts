import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

let resources: Record<string, { type: string; inputs: Record<string, unknown> }> = {};

beforeAll(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } => {
      resources[args.name] = {
        type: args.type,
        inputs: args.inputs,
      };

      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "gcp:serviceaccount/account:Account") {
        state.email = `${(args.inputs.accountId as string) || args.name}@mock-project.iam.gserviceaccount.com`;
      }
      if (args.type.includes("cloudrunv2/service:Service")) {
        state.uri = `https://${(args.inputs.name as string) || args.name}-mock.a.run.app`;
        state.name = args.inputs.name || args.name;
        state.location = args.inputs.location || "us-east4";
      }
      if (args.type.includes("artifactregistry/repository:Repository")) {
        state.name = `projects/mock-project/locations/${(args.inputs.location as string) || "us-east4"}/repositories/${(args.inputs.repositoryId as string) || args.name}`;
      }
      if (args.type.includes("projects/serviceIdentity:ServiceIdentity")) {
        state.email = `service-mock@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
        state.member = `serviceAccount:${state.email}`;
      }

      return {
        id: args.name + "_id",
        state,
      };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "gcp:organizations/getProject:getProject") {
        const projectId = (args.inputs as { projectId?: string })?.projectId;
        if (projectId === "inc-io-docs-prod") {
          return { number: "987654321098", projectId };
        }
        if (projectId === "inc-io-docs-dev") {
          return { number: "137115190443", projectId };
        }
        return { number: "123456789012", projectId };
      }
      return args.inputs;
    },
  });
});

beforeEach(() => {
  resources = {};
});

describe("AppInfrastructure ComponentResource", () => {
  it("creates dev stack with dedicated runtime SA, Workspace Add-ons service identity, and least-privilege IAM", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    const infra = new AppInfrastructure("dev-infra", {
      projectId: "inc-io-docs-dev",
      region: "us-east4",
      repositoryName: "inc-io-docs",
      serviceName: "inc-io-docs-dev",
      invokerName: "addon-invoker",
      port: 8080,
    });

    const repoUrl = await promiseOf(infra.repositoryUrl);
    const serviceUrl = await promiseOf(infra.serviceUrl);
    const invokerEmail = await promiseOf(infra.invokerServiceAccountEmail);
    const runtimeSaEmail = await promiseOf(infra.runtimeServiceAccount.email);
    const runtimeSaAccountId = await promiseOf(infra.runtimeServiceAccount.accountId);
    const invokerIamId = await promiseOf(infra.invokerIamMember.id);
    const workspaceIamId = await promiseOf(infra.workspaceIamMember.id);

    expect(repoUrl).toContain("us-east4-docker.pkg.dev/inc-io-docs-dev/inc-io-docs");
    expect(serviceUrl).toBe("https://inc-io-docs-dev-mock.a.run.app");
    expect(invokerEmail).toBe("addon-invoker@mock-project.iam.gserviceaccount.com");
    expect(runtimeSaEmail).toBe("addon-runtime@mock-project.iam.gserviceaccount.com");
    expect(runtimeSaAccountId).toBe("addon-runtime");
    expect(invokerIamId).toBeDefined();
    expect(workspaceIamId).toBeDefined();

    // Check Artifact Registry repository resource
    const repoRes = Object.values(resources).find(
      (r) => r.type.includes("artifactregistry/repository:Repository")
    );
    expect(repoRes).toBeDefined();
    expect(repoRes?.inputs.format).toBe("DOCKER");
    expect(repoRes?.inputs.repositoryId).toBe("inc-io-docs");
    expect(repoRes?.inputs.project).toBe("inc-io-docs-dev");

    // Check Invoker Service Account resource
    const invokerSaRes = Object.values(resources).find(
      (r) => r.type.includes("serviceaccount/account:Account") && r.inputs.accountId === "addon-invoker"
    );
    expect(invokerSaRes).toBeDefined();
    expect(invokerSaRes?.inputs.displayName).toBe("Dedicated Cloud Run Invoker for Workspace Add-on");

    // Check Runtime Service Account resource (zero project IAM bindings)
    const runtimeSaRes = Object.values(resources).find(
      (r) => r.type.includes("serviceaccount/account:Account") && r.inputs.accountId === "addon-runtime"
    );
    expect(runtimeSaRes).toBeDefined();
    expect(runtimeSaRes?.inputs.displayName).toBe("Zero-Privilege Cloud Run Runtime Service Account");
    expect(runtimeSaRes?.inputs.project).toBe("inc-io-docs-dev");

    // Verify zero project-level IAM bindings created for addon-runtime
    const runtimeSaBindings = Object.values(resources).filter(
      (r) =>
        r.type.includes("IAM") &&
        (r.inputs.member as string)?.includes("addon-runtime")
    );
    expect(runtimeSaBindings.length).toBe(0);

    // Check Workspace Add-ons Service Identity resource
    const serviceIdentityRes = Object.values(resources).find(
      (r) => r.type.includes("projects/serviceIdentity:ServiceIdentity")
    );
    expect(serviceIdentityRes).toBeDefined();
    expect(serviceIdentityRes?.inputs.service).toBe("gsuiteaddons.googleapis.com");
    expect(serviceIdentityRes?.inputs.project).toBe("inc-io-docs-dev");

    // Check Cloud Run Service resource
    const runRes = Object.values(resources).find(
      (r) => r.type.includes("cloudrunv2/service:Service")
    );
    expect(runRes).toBeDefined();
    expect(runRes?.inputs.location).toBe("us-east4");
    expect(runRes?.inputs.name).toBe("inc-io-docs-dev");
    expect(runRes?.inputs.project).toBe("inc-io-docs-dev");

    // Check Cloud Run template serviceAccount attachment
    const template = runRes?.inputs.template as {
      serviceAccount?: string;
      containers?: Array<{ envs?: Array<{ name: string; value: string }> }>;
    };
    expect(template?.serviceAccount).toBe("addon-runtime@mock-project.iam.gserviceaccount.com");

    // Check Cloud Run container envs
    const envs = template?.containers?.[0]?.envs;
    expect(envs).toContainEqual({
      name: "NODE_ENV",
      value: "production",
    });
    expect(envs).toContainEqual({
      name: "NODE_OPTIONS",
      value: "--max-old-space-size=3584",
    });
    expect(envs).toContainEqual({
      name: "SKIP_SPACE_VALIDATION",
      value: "true",
    });

    // Check IAM Bindings for Cloud Run: exactly 2 (invoker SA and workspace add-ons SA)
    const iamBindings = Object.values(resources).filter(
      (r) => r.type.includes("ServiceIamMember")
    );
    expect(iamBindings.length).toBe(2);

    const invokerIamRes = iamBindings.find(
      (r) => r.inputs.member === "serviceAccount:addon-invoker@mock-project.iam.gserviceaccount.com"
    );
    expect(invokerIamRes).toBeDefined();
    expect(invokerIamRes?.inputs.role).toBe("roles/run.invoker");

    const workspaceIamRes = iamBindings.find(
      (r) => r.inputs.member === "serviceAccount:service-137115190443@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"
    );
    expect(workspaceIamRes).toBeDefined();
    expect(workspaceIamRes?.inputs.role).toBe("roles/run.invoker");

    // Verify NO public access (allUsers / allAuthenticatedUsers) IAM binding exists
    const publicAccessBinding = Object.values(resources).find(
      (r) =>
        r.type.includes("Iam") &&
        (r.inputs.member === "allUsers" ||
          r.inputs.member === "allAuthenticatedUsers" ||
          (r.inputs.members as string[])?.includes("allUsers") ||
          (r.inputs.members as string[])?.includes("allAuthenticatedUsers"))
    );
    expect(publicAccessBinding).toBeUndefined();
  });

  it("creates prod stack with dynamically resolved prod project number and runtime SA", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    const prodInfra = new AppInfrastructure("prod-infra", {
      projectId: "inc-io-docs-prod",
      region: "us-east4",
      repositoryName: "inc-io-docs",
      serviceName: "inc-io-docs-prod",
      invokerName: "addon-invoker",
    });

    const repoUrl = await promiseOf(prodInfra.repositoryUrl);
    const serviceUrl = await promiseOf(prodInfra.serviceUrl);
    const prodRuntimeSaEmail = await promiseOf(prodInfra.runtimeServiceAccount.email);
    const prodRuntimeSaAccountId = await promiseOf(prodInfra.runtimeServiceAccount.accountId);
    const invokerIamId = await promiseOf(prodInfra.invokerIamMember.id);
    const workspaceIamId = await promiseOf(prodInfra.workspaceIamMember.id);

    expect(repoUrl).toContain("us-east4-docker.pkg.dev/inc-io-docs-prod/inc-io-docs");
    expect(serviceUrl).toBe("https://inc-io-docs-prod-mock.a.run.app");
    expect(prodRuntimeSaEmail).toBe("addon-runtime@mock-project.iam.gserviceaccount.com");
    expect(prodRuntimeSaAccountId).toBe("addon-runtime");
    expect(invokerIamId).toBeDefined();
    expect(workspaceIamId).toBeDefined();

    // Check Cloud Run Service
    const runRes = Object.values(resources).find(
      (r) => r.type.includes("cloudrunv2/service:Service") && r.inputs.name === "inc-io-docs-prod"
    );
    expect(runRes).toBeDefined();
    expect(runRes?.inputs.project).toBe("inc-io-docs-prod");

    const template = runRes?.inputs.template as {
      serviceAccount?: string;
      containers?: Array<{ envs?: Array<{ name: string; value: string }> }>;
    };
    expect(template?.serviceAccount).toBe("addon-runtime@mock-project.iam.gserviceaccount.com");
    expect(template?.containers?.[0]?.envs).toContainEqual({
      name: "NODE_ENV",
      value: "production",
    });

    // Check workspace IAM member dynamically resolved to prod project number 987654321098
    const iamBindings = Object.values(resources).filter(
      (r) => r.type.includes("ServiceIamMember")
    );
    const workspaceIamRes = iamBindings.find(
      (r) => r.inputs.member === "serviceAccount:service-987654321098@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"
    );
    expect(workspaceIamRes).toBeDefined();
    expect(workspaceIamRes?.inputs.role).toBe("roles/run.invoker");
    expect(workspaceIamRes?.inputs.project).toBe("inc-io-docs-prod");

    // Zero public access bindings
    const publicAccessBinding = Object.values(resources).find(
      (r) =>
        r.type.includes("Iam") &&
        (r.inputs.member === "allUsers" || r.inputs.member === "allAuthenticatedUsers")
    );
    expect(publicAccessBinding).toBeUndefined();
  });

  it("fails fast when neither args.projectId nor gcp:project is configured", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    expect(() => {
      new AppInfrastructure("fail-infra", {});
    }).toThrow(/gcp:project|project/i);
  });

  it("supports custom runtimeAccountName when provided", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    const infra = new AppInfrastructure("custom-infra", {
      projectId: "inc-io-docs-dev",
      runtimeAccountName: "custom-addon-runtime",
    });

    await promiseOf(infra.serviceUrl);
    await promiseOf(infra.workspaceIamMember.id);
    const customRuntimeEmail = await promiseOf(infra.runtimeServiceAccount.email);
    const customRuntimeAccountId = await promiseOf(infra.runtimeServiceAccount.accountId);

    expect(customRuntimeEmail).toBe("custom-addon-runtime@mock-project.iam.gserviceaccount.com");
    expect(customRuntimeAccountId).toBe("custom-addon-runtime");

    const runtimeSaRes = Object.values(resources).find(
      (r) => r.type.includes("serviceaccount/account:Account") && r.inputs.accountId === "custom-addon-runtime"
    );
    expect(runtimeSaRes).toBeDefined();

    const runRes = Object.values(resources).find(
      (r) => r.type.includes("cloudrunv2/service:Service") && r.inputs.name === "custom-infra"
    );
    const template = runRes?.inputs.template as { serviceAccount?: string };
    expect(template?.serviceAccount).toBe("custom-addon-runtime@mock-project.iam.gserviceaccount.com");
  });

  it("binds custom container image when args.image is provided", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    const infra = new AppInfrastructure("custom-image-infra", {
      projectId: "inc-io-docs-dev",
      image: "custom-image:v1",
    });

    await promiseOf(infra.serviceUrl);

    const runRes = Object.values(resources).find(
      (r) => r.type.includes("cloudrunv2/service:Service") && r.inputs.name === "custom-image-infra"
    );
    expect(runRes).toBeDefined();

    const template = runRes?.inputs.template as {
      containers?: Array<{ image?: string }>;
    };
    expect(template?.containers?.[0]?.image).toBe("custom-image:v1");
  });

  it("falls back to default hello container image when args.image is omitted or undefined", async () => {
    const { AppInfrastructure } = await import("./app-infrastructure");

    const infra = new AppInfrastructure("default-image-infra", {
      projectId: "inc-io-docs-dev",
    });

    await promiseOf(infra.serviceUrl);

    const runRes = Object.values(resources).find(
      (r) => r.type.includes("cloudrunv2/service:Service") && r.inputs.name === "default-image-infra"
    );
    expect(runRes).toBeDefined();

    const template = runRes?.inputs.template as {
      containers?: Array<{ image?: string }>;
    };
    expect(template?.containers?.[0]?.image).toBe("us-docker.pkg.dev/cloudrun/container/hello");
  });

  it("maintains structural parity between Pulumi.dev.yaml and Pulumi.prod.yaml", () => {
    const devPath = path.resolve(__dirname, "Pulumi.dev.yaml");
    const prodPath = path.resolve(__dirname, "Pulumi.prod.yaml");

    expect(fs.existsSync(devPath)).toBe(true);
    expect(fs.existsSync(prodPath)).toBe(true);

    const devContent = fs.readFileSync(devPath, "utf8");
    const prodContent = fs.readFileSync(prodPath, "utf8");

    const devYaml = YAML.parse(devContent);
    const prodYaml = YAML.parse(prodContent);

    // Top-level structure
    expect(Object.keys(devYaml).sort()).toEqual(Object.keys(prodYaml).sort());
    expect(typeof devYaml.encryptionsalt).toBe("string");
    expect(devYaml.encryptionsalt.length).toBeGreaterThan(0);
    expect(typeof prodYaml.encryptionsalt).toBe("string");
    expect(prodYaml.encryptionsalt.length).toBeGreaterThan(0);

    // Config keys parity
    expect(Object.keys(devYaml.config).sort()).toEqual(Object.keys(prodYaml.config).sort());

    // Dev values
    expect(devYaml.config["gcp:project"]).toBe("inc-io-docs-dev");
    expect(devYaml.config["gcp:region"]).toBe("us-east4");
    expect(devYaml.config["inc-io-docs-infra:repositoryName"]).toBe("inc-io-docs");
    expect(devYaml.config["inc-io-docs-infra:serviceName"]).toBe("inc-io-docs-dev");
    expect(devYaml.config["inc-io-docs-infra:invokerName"]).toBe("addon-invoker");

    // Prod values
    expect(prodYaml.config["gcp:project"]).toBe("inc-io-docs-prod");
    expect(prodYaml.config["gcp:region"]).toBe("us-east4");
    expect(prodYaml.config["inc-io-docs-infra:repositoryName"]).toBe("inc-io-docs");
    expect(prodYaml.config["inc-io-docs-infra:serviceName"]).toBe("inc-io-docs-prod");
    expect(prodYaml.config["inc-io-docs-infra:invokerName"]).toBe("addon-invoker");
  });
});

