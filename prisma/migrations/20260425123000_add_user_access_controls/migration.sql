CREATE TABLE "UserModuleAccess" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserModuleAccess_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserMachineAccess" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "machineId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMachineAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserModuleAccess_userId_moduleKey_key" ON "UserModuleAccess"("userId", "moduleKey");
CREATE INDEX "UserModuleAccess_moduleKey_idx" ON "UserModuleAccess"("moduleKey");
CREATE UNIQUE INDEX "UserMachineAccess_userId_machineId_key" ON "UserMachineAccess"("userId", "machineId");
CREATE INDEX "UserMachineAccess_machineId_idx" ON "UserMachineAccess"("machineId");

ALTER TABLE "UserModuleAccess" ADD CONSTRAINT "UserModuleAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMachineAccess" ADD CONSTRAINT "UserMachineAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMachineAccess" ADD CONSTRAINT "UserMachineAccess_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
