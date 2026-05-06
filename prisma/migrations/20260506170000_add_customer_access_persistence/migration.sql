CREATE TABLE "CustomerAccess" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "allowedMachines" JSONB NOT NULL DEFAULT '[]',
    "machineIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "allowedModules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedFeatures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedParameters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerAccess_email_key" ON "CustomerAccess"("email");
CREATE INDEX "CustomerAccess_email_idx" ON "CustomerAccess"("email");
