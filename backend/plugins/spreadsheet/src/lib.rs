mod error;
mod handler;
mod models;
mod rules;
mod source;
mod workbook;
mod worker;
pub(crate) use error::{Error, Result};
pub use handler::execute;
#[cfg(test)]
mod tests;
