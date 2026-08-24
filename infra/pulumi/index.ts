import * as pulumi from "@pulumi/pulumi";
import { AppInfrastructure } from "./app-infrastructure";

const infraConfig = new pulumi.Config("inc-io-docs-infra");

const infra = new AppInfrastructure("app-infra", {
  repositoryName: infraConfig.get("repositoryName"),
  serviceName: infraConfig.get("serviceName"),
  invokerName: infraConfig.get("invokerName"),
  image: infraConfig.get("image"),
  port: infraConfig.getNumber("port"),
});

export const repositoryUrl = infra.repositoryUrl;
export const serviceUrl = infra.serviceUrl;
export const invokerServiceAccountEmail = infra.invokerServiceAccountEmail;
export { AppInfrastructure } from "./app-infrastructure";
