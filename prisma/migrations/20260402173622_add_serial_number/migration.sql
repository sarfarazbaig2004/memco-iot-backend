/*
  Warnings:

  - A unique constraint covering the columns `[serialNumber]` on the table `Machine` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "serialNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Machine_serialNumber_key" ON "Machine"("serialNumber");
